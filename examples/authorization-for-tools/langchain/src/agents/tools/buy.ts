import { z } from "zod/v3";

import { Auth0AI } from "@auth0/ai-langchain";
import { tool } from "@langchain/core/tools";

const auth0AI = new Auth0AI.FGA();

const useFGA = auth0AI.withFGA({
  buildQuery: async (params, ctx) => {
    return {
      user: `user:${ctx.configurable?.user_id}`,
      object: `asset:${params.ticker}`,
      relation: "can_buy",
      context: { current_time: new Date().toISOString() },
    };
  },
  onUnauthorized(params) {
    console.log("onUnauthorized", params);
    return `The user is not allowed to buy ${params.ticker}.`;
  },
});

export const buyTool = useFGA(
  tool(
    async ({ ticker, qty }) => {
      return `Purchased ${qty} shares of ${ticker}`;
    },
    {
      name: "buy",
      description: "Use this function to buy stock",
      schema: z.object({
        ticker: z.string(),
        qty: z.number(),
      }),
    }
  )
);
