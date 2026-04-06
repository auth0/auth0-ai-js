import "dotenv/config";

import { tool } from "ai";
import Enquirer from "enquirer";
import { z } from "zod/v3";

import { getAsyncAuthorizationCredentials } from "@auth0/ai-vercel";

import { useAsyncAuthz } from "../authorizers/asyncAuthorization";
import { useDeviceFLow } from "../authorizers/deviceFlow";

export const buy = useDeviceFLow(
  useAsyncAuthz(
    tool({
      description: "Use this function to buy stock",
      inputSchema: z.object({
        ticker: z.string(),
        qty: z.number(),
      }),
      execute: async ({ ticker, qty }, cfg) => {
        const headers = {
          "Content-Type": "application/json",
        };
        const body = {
          ticker: ticker,
          qty: qty,
        };

        const credentials = getAsyncAuthorizationCredentials();
        const accessToken = credentials?.accessToken;

        if (accessToken) {
          headers["Authorization"] = "Bearer " + accessToken;
        }

        const response = await fetch(process.env["API_URL"]!, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(body),
        });

        return response.statusText;
      },
    })
  )
);
