import { tool } from "llamaindex";
import { z } from "zod/v3";

import { withSlack } from "@/app/(llamaindex)/lib/auth0-ai";
import { getCredentialsFromTokenVault } from "@auth0/ai-llamaindex";
import { TokenVaultError } from "@auth0/ai/interrupts";
import { ErrorCode, WebClient } from "@slack/web-api";

export const listChannels = () =>
  withSlack(
    tool(
      async () => {
        // Get the access token from Auth0 AI
        const credentials = getCredentialsFromTokenVault();

        // Slack SDK
        try {
          const web = new WebClient(credentials?.accessToken);

          const result = await web.conversations.list({
            exclude_archived: true,
            types: "public_channel,private_channel",
            limit: 10,
          });

          return (
            result.channels
              ?.map((channel) => channel.name)
              .filter((name): name is string => name !== undefined) || []
          );
        } catch (error) {
          if (error && typeof error === "object" && "code" in error) {
            if (error.code === ErrorCode.HTTPError) {
              throw new TokenVaultError(
                `Authorization required to access the Token Vault`
              );
            }
          }

          throw error;
        }
      },
      {
        name: "listChannels",
        description: "List channels for the current user on Slack",
        parameters: z.object({}),
      }
    )
  );
