import { z } from "genkit";
import { GenkitBeta } from "genkit/beta";

import { getAsyncAuthorizationCredentials } from "@auth0/ai-genkit";

import { useAsyncAuthz } from "../authorizers/asyncAuthorization";
import { useDeviceFLow } from "../authorizers/deviceFlow";

export function buyTool(ai: GenkitBeta) {
  return ai.defineTool(
    ...useDeviceFLow(
      ...useAsyncAuthz(
        {
          name: "buy",
          description: "Use this function to buy stock",
          inputSchema: z.object({
            ticker: z.string(),
            qty: z.number(),
          }),
          outputSchema: z.string(),
        },
        async ({ ticker, qty }) => {
          const headers = {
            Authorization: "",
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
        }
      )
    )
  );
}
