import { Tool, tool } from "ai";
import { google } from "googleapis";
import { z } from "zod";

import { isZodSchema } from "@agentic/core";
import { GoogleDriveClient } from "@agentic/google-drive";
import { getAccessTokenFromTokenVault } from "@auth0/ai-vercel";

import { withGoogleDriveTools } from "../auth0-ai";

const auth = new google.auth.OAuth2();
const drive = google.drive({ version: "v3", auth });
const client = new GoogleDriveClient({ drive });

export const googleDriveTools = Object.fromEntries(
  client.functions.map((fn) => [
    fn.spec.name,
    withGoogleDriveTools(
      tool({
        description: fn.spec.description,
        // In AI SDK 5, inputSchema must be a Zod schema
        // If @agentic already provides a Zod schema, use it directly
        // Otherwise, create a passthrough schema that accepts any object
        inputSchema: isZodSchema(fn.inputSchema)
          ? fn.inputSchema
          : z.object({}).passthrough(),
        execute: async (args) => {
          // Get the access token from Auth0 AI
          try {
            const accessToken = getAccessTokenFromTokenVault();

            if (!accessToken) {
              throw new Error(
                "No access token returned from getAccessTokenFromTokenVault"
              );
            }

            auth.setCredentials({
              access_token: accessToken,
            });

            // Simplified sanitization: remove null values, map `query` -> `q`, coerce pageSize
            let sanitizedArgs: any = args;
            if (
              sanitizedArgs &&
              typeof sanitizedArgs === "object" &&
              !Array.isArray(sanitizedArgs)
            ) {
              sanitizedArgs = Object.fromEntries(
                Object.entries(sanitizedArgs).filter(([, v]) => v !== null)
              );

              if (typeof sanitizedArgs.query === "string") {
                const baseQ = sanitizedArgs.query.trim();
                sanitizedArgs.q = /trashed\s*=/.test(baseQ)
                  ? baseQ
                  : `${baseQ} and trashed = false`;
                delete sanitizedArgs.query;
              }

              if (sanitizedArgs.pageSize != null) {
                sanitizedArgs.pageSize = Number(sanitizedArgs.pageSize);
              }
            }

            // Execute Google Drive function from `@agentic`
            return await fn.execute(sanitizedArgs);
          } catch (err: any) {
            if (err?.response?.data) {
              console.error(
                "google-drive-tools: drive api error response.data:",
                err.response.data
              );
            }
            throw err;
          }
        },
      }) as Tool
    ),
  ])
);
