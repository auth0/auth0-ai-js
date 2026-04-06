import { genkit } from "genkit/beta";
import { gpt4o, openAI } from "genkitx-openai";

export const ai = genkit({
  plugins: [openAI({ apiKey: process.env.OPENAI_API_KEY })],
  model: gpt4o,
});
