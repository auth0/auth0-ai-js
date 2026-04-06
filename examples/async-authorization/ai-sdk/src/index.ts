import "dotenv/config";

import { generateText, ModelMessage, stepCountIs } from "ai";
import Enquirer from "enquirer";
import crypto from "node:crypto";

import { openai } from "@ai-sdk/openai";
import { setAIContext } from "@auth0/ai-vercel";

import { buy } from "./tools/buy";

async function generate(messages: ModelMessage[]) {
  const result = await generateText({
    model: openai("gpt-4o-mini"),
    messages,
    stopWhen: stepCountIs(2),
    tools: {
      buy,
    },
  });
  return result;
}

async function main() {
  const threadID = crypto.randomUUID();
  setAIContext({ threadID });
  console.log(`Thread ID: ${threadID}`);
  console.log(`<Enter a command (type "exit" to quit)>\n\n`);

  const enquirer = new Enquirer<{ prompt: string }>();

  const messages: ModelMessage[] = [];

  try {
    while (true) {
      const { prompt } = await enquirer.prompt({
        type: "text",
        name: "prompt",
        message: "    ",
        prefix: "User",
      });

      if (prompt.toLowerCase() === "exit") {
        console.log("Goodbye!");
        break;
      }

      // Add the user's message to the messages
      messages.push({ role: "user", content: prompt });

      const { response, text } = await generate(messages);

      // Update the messages with the response
      messages.push(...response.messages);

      console.log(`Assistant · ${text}\n`);
    }
  } catch (error) {
    console.log("AGENT:error", error);
  }
}

main().catch(console.error);
