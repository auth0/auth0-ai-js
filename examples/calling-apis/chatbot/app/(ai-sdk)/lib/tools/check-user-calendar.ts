import { tool } from "ai";
import { addDays, formatISO } from "date-fns";
import { GaxiosError } from "gaxios";
import { google } from "googleapis";
import { z } from "zod/v3";

import { withGoogleCalendar } from "@/app/(ai-sdk)/lib/auth0-ai";
import { getAccessTokenFromTokenVault } from "@auth0/ai-vercel";
import { TokenVaultError } from "@auth0/ai/interrupts";

export const checkUsersCalendar = withGoogleCalendar(
  tool({
    description:
      "Check user availability on a given date time on their calendar",
    inputSchema: z.object({
      date: z.coerce.date(),
    }),
    execute: async ({ date }) => {
      // Get the access token from Auth0 AI
      const accessToken = getAccessTokenFromTokenVault();

      // Google SDK
      try {
        const calendar = google.calendar("v3");
        const auth = new google.auth.OAuth2();

        auth.setCredentials({
          access_token: accessToken,
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
    },
  })
);
