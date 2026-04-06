import { tool } from "ai";
import { z } from "zod/v3";

import { getAsyncAuthorizationCredentials } from "@auth0/ai-vercel";

import { withAsyncAuthorization } from "../auth0ai";

export const buyStock = withAsyncAuthorization(
  tool({
    description: "Execute an stock purchase given stock ticker and quantity",
    inputSchema: z.object({
      tradeID: z
        .string()
        .uuid()
        .describe("The unique identifier for the trade provided by the user"),
      userID: z
        .string()
        .describe("The user ID of the user who created the conditional trade"),
      ticker: z.string().describe("The stock ticker to trade"),
      qty: z
        .number()
        .int()
        .positive()
        .describe("The quantity of shares to trade"),
    }),
    execute: async ({ userID, ticker, qty }, ctx): Promise<string> => {
      const credentials = getAsyncAuthorizationCredentials();
      console.log(
        `The token obtained with ciba is ${credentials?.accessToken}`
      );
      return `Just bought ${qty} shares of ${ticker} for ${userID}`;
    },
  })
);
