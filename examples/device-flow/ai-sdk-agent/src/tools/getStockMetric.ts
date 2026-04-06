import { tool } from "ai";
import { z } from "zod/v3";

export const getStockMetric = tool({
  description: "Get a stock metric",
  inputSchema: z.object({
    ticker: z.string(),
    metric: z.enum(["PE", "P/S", "P/B", "P/FCF", "P/EBITDA"]),
  }),
  execute: async ({ ticker, metric }) => {
    console.log(`Getting ${metric} for ${ticker}`);
    return Math.random() * 50;
  },
});
