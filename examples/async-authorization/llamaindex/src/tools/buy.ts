import "dotenv/config";

import { tool } from "llamaindex";
import { z } from "zod/v3";

import { getAsyncAuthorizationCredentials } from "@auth0/ai-llamaindex";

import { useAsyncAuthz } from "../authorizers/asyncAuthorization";
import { useDeviceFlow } from "../authorizers/deviceFlow";

export const buyTool = () => {
  return useDeviceFlow(
    useAsyncAuthz(
      tool(
        async ({ ticker, qty }) => {
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
          } else {
            return "Not authorized to perform this action";
          }

          const response = await fetch(process.env["API_URL"]!, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body),
          });
          return response.statusText;
        },
        {
          name: "buy",
          description: "Use this function to buy stock",
          parameters: z.object({
            ticker: z.string(),
            qty: z.number(),
          }),
        }
      )
    )
  );
};
