import { z } from "zod/v3";

import { tool } from "@langchain/core/tools";
import { LangGraphRunnableConfig } from "@langchain/langgraph";

import { SchedulerClient } from "../../services/client";

/**
 * This tool schedules a conditional trade for a stock based on a financial metric.
 *
 * This tool is only used in the "agent" graph.
 *
 * For example it can be triggerd with the chat command.
 */
export const conditionalTrade = tool(
  async (input, config: LangGraphRunnableConfig) => {
    // Schedule the conditional trade
    await SchedulerClient().schedule({
      assistantID: "conditional-trade",
      payload: {
        config: {
          configurable: {
            user_id: config?.configurable?.user_id ?? process.env.TEST_USER_ID,
          },
        },
        input: {
          data: {
            ...input,
          },
        },
      },
    });

    console.log("----");
    console.log(`Starting conditional trading for: ${input.ticker}`);
    console.log("----");

    return "Conditional trading started";
  },
  {
    name: "conditional_trade_tool",
    description:
      "Use this function to schedule the trade of an stock based on a condition",
    schema: z.object({
      ticker: z.string(),
      qty: z.number(),
      metric: z
        .enum(["P/E", "EPS", "P/B", "D/E", "ROE", "RSI", "price"])
        .describe("The financial metric to monitor."),
      operator: z
        .enum(["=", "<", "<=", ">", ">="])
        .describe("The comparison operator to evaluate the condition."),
      threshold: z
        .number()
        .describe(
          "The threshold value of the financial variable that triggers the buy action."
        ),
    }),
  }
);
