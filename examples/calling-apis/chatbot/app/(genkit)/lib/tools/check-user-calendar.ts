import { addDays, formatISO } from "date-fns";
import { GaxiosError } from "gaxios";
import { google } from "googleapis";
import { z } from "zod/v3";

import { withTokenForGoogleConnection } from "@/app/(genkit)/lib/auth0-ai";
import { ai } from "@/app/(genkit)/lib/genkit";
import { getCredentialsFromTokenVault } from "@auth0/ai-genkit";
import { TokenVaultError } from "@auth0/ai/interrupts";

export const checkUsersCalendar = ai.defineTool(
  ...withTokenForGoogleConnection(
    {
      description:
        "Check user availability on a given date time on their calendar",
      inputSchema: z.object({
        date: z.coerce
          .date()
          .describe("Date to check availability for in UTC time always."),
      }),
      outputSchema: z.object({
        available: z.boolean(),
      }),
      name: "checkUsersCalendar",
    },
    async ({ date }) => {
      // Get the access token from Auth0 AI
      const credentials = getCredentialsFromTokenVault();

      // Google SDK
      try {
        const calendar = google.calendar("v3");
        const auth = new google.auth.OAuth2();

        auth.setCredentials({
          access_token: credentials?.accessToken,
        });

        const response = await calendar.freebusy.query({
          auth,
          requestBody: {
            timeMin: formatISO(date),
            timeMax: addDays(date, 1).toISOString(),
            timeZone: "UTC",
            items: [{ id: "primary" }],
          },
        });

        return {
          available: response.data?.calendars?.primary?.busy?.length === 0,
        };
      } catch (error) {
        if (error instanceof GaxiosError) {
          if (error.status === 401) {
            throw new TokenVaultError(
              `Authorization required to access the Token Vault`
            );
          }
        }

        throw error;
      }
    }
  )
);
