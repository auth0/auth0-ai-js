import "dotenv/config";

import { tool } from "ai";
import { z } from "zod/v3";

import { Auth0AI } from "@auth0/ai-vercel";

import { Context } from "../context";

const auth0AI = new Auth0AI.FGA();

export const buy = (context: Context) => {
  const useFGA = auth0AI.withFGA({
    buildQuery: async ({ ticker }: { ticker: string; qty: number }) => {
      return {
        user: `user:${context.userId}`,
        object: `asset:${ticker}`,
        relation: "can_buy",
        context: { current_time: new Date().toISOString() },
      };
    },
    onUnauthorized({ ticker }: { ticker: string; qty: number }) {
      return `The user is not allowed to buy ${ticker}.`;
    },
  });

  return useFGA(
    tool({
      description: "Use this function to buy stock",
      inputSchema: z.object({
        ticker: z.string(),
        qty: z.number(),
      }),
      execute: async ({ ticker, qty }) => {
        return `Purchased ${qty} shares of ${ticker}`;
      },
    })
  );
};
