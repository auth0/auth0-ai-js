import "dotenv/config";

import { FunctionTool } from "llamaindex";
import { z } from "zod/v3";

import { Auth0AI } from "@auth0/ai-llamaindex";

import { Context } from "../context";

const auth0AI = new Auth0AI.FGA();

export const buyTool = (context: Context) => {
  const useFGA = auth0AI.withFGA({
    buildQuery: async (params) => {
      return {
        user: `user:${context.userId}`,
        object: `asset:${params.ticker}`,
        relation: "can_buy",
        context: { current_time: new Date().toISOString() },
      };
    },
    onUnauthorized(params) {
      return `The user is not allowed to buy ${params.ticker}.`;
    },
  });

  return useFGA(
    FunctionTool.from(
      async ({ ticker, qty }: { ticker: string; qty: number }) => {
        return `Purchased ${qty} shares of ${ticker}`;
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
  );
};
