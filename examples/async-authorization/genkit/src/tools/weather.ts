import { z } from "genkit";
import { GenkitBeta } from "genkit/beta";

export function weather(ai: GenkitBeta) {
  return ai.defineTool(
    {
      name: "weather",
      description: "Use this function to get the weather for a city",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.string(),
    },
    async ({ city }, ctx) => {
      return `snowy in ${city} - 10 degrees celsius`;
    }
  );
}
