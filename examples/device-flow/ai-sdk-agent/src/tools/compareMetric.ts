import { tool } from "ai";
import { z } from "zod/v3";

export const compareMetric = tool({
  description: "Compare a metric to a given treshold using a given operator",
  inputSchema: z.object({
    operator: z.enum([">", "<", ">=", "<=", "==", "!="]),
    treshold: z.number().describe("The value to compare the metric to"),
    current: z.number().describe("The current value of the metric"),
  }),
  execute: async ({ operator, current, treshold }) => {
    console.log(`Comparing ${current} ${operator} ${treshold}`);
    switch (operator) {
      case ">":
        return current > treshold;
      case "<":
        return current < treshold;
      case ">=":
        return current >= treshold;
      case "<=":
        return current <= treshold;
      case "==":
        return current === treshold;
      case "!=":
        return current !== treshold;
    }
  },
});
