import { AISDKError, generateText, ModelMessage } from "ai";
import { Job } from "bullmq";

import { queue } from "@/src/queue";
import { buyStock } from "@/src/tools/buyStock";
import { compareMetric } from "@/src/tools/compareMetric";
import { getStockMetric } from "@/src/tools/getStockMetric";
import { notifyUser } from "@/src/tools/notifyUser";
import { openai } from "@ai-sdk/openai";
import { setAIContext } from "@auth0/ai-vercel";
import { invokeTools } from "@auth0/ai-vercel/interrupts";
import {
  Auth0Interrupt,
  AuthorizationPendingInterrupt,
  AuthorizationPollingInterrupt,
} from "@auth0/ai/interrupts";

import { ConditionalTrade } from "../../ConditionalTrade";

export type ConditionalTradeHandlerParams = ConditionalTrade & {
  messages?: ModelMessage[];
};

export const conditionalTrade = async (
  job: Job<ConditionalTradeHandlerParams>
) => {
  console.log(`Handling conditional trade job ${job.id}`);
  setAIContext({ threadID: job.id! });

  const { messages: previousMessages, ...conditionalTrade } = job.data;
  const messages = previousMessages || [
    {
      role: "user",
      content: `I would like to execute the following conditional trade:

      ${JSON.stringify(conditionalTrade)}

      Once the trade is actually executed and the stock is purchased, please notify me via email.
`,
    },
  ];

  try {
    const tools = {
      getStockMetric,
      compareMetric,
      buyStock,
      notifyUser,
    };

    console.log(`Invoking previously interrupted tools if any`);
    await invokeTools({
      messages,
      tools,
      onToolResult: async (message: ModelMessage) => {
        messages.push(message);
        await job.updateData({
          ...conditionalTrade,
          messages,
        });
      },
    });

    console.log(`Calling the LLM`);
    const r = await generateText({
      model: openai("gpt-4o"),
      system:
        "You are a fictional stock trader bot. Please execute the trades of the user.",
      messages,
      tools,
      onStepFinish: async (step) => {
        const newMessages = [...messages, ...step.response.messages];
        await job.updateData({
          ...conditionalTrade,
          messages: newMessages,
        });
        const conditionIsMet = step.toolResults.some(
          (r) => r.toolName === "compareMetric" && r.output === true
        );
        if (conditionIsMet) {
          console.log("Condition met! Stopping the scheduler");
          await queue.removeJobScheduler(job.data.tradeID);
        }
      },
    });
    console.log(`${r.text}`);
  } catch (err) {
    if (err instanceof AISDKError && Auth0Interrupt.isInterrupt(err.cause)) {
      console.log("Handling tool execution interruption (no synthetic append)");
      // In SDK v5 the originating tool-call message already exists from the model output;
      // we persist current messages without modification.
      await job.updateData({
        ...conditionalTrade,
        messages,
      });

      const authorizationPendingInterAuthorizationPendingInterrupt =
        AuthorizationPendingInterrupt.isInterrupt(err.cause) ||
        AuthorizationPollingInterrupt.isInterrupt(err.cause);

      console.log(err.cause.message);

      if (!authorizationPendingInterAuthorizationPendingInterrupt) {
        console.log("Authorization is not pending, do not retry.");
        return;
      }
    }

    throw err;
  }
};
