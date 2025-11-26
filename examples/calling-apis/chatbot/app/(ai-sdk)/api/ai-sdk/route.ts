import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  UIMessage,
} from "ai";

import {
  checkUsersCalendar,
  googleDriveTools,
  listChannels,
  listRepositories,
} from "@/app/(ai-sdk)/lib/tools/";
import { openai } from "@ai-sdk/openai";
import { setAIContext } from "@auth0/ai-vercel";
import {
  errorSerializer,
  withInterruptions,
} from "@auth0/ai-vercel/interrupts";

export async function POST(request: Request) {
  const {
    id,
    messages,
  }: { id: string; messages: Array<UIMessage>; selectedChatModel: string } =
    await request.json();

  setAIContext({ threadID: id });

  const tools = {
    checkUsersCalendar,
    listRepositories,
    listChannels,
    ...googleDriveTools,
  };

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: withInterruptions(
      async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o-mini"),
          system:
            `You are a friendly assistant! Keep your responses concise and helpful. Today is ${new Date().toISOString()}.`,
          messages: convertToModelMessages(messages),
          tools,

          onFinish: (output) => {
            if (output.finishReason === "tool-calls") {
              const lastMessage = output.content[output.content.length - 1];
              if (lastMessage?.type === "tool-error") {
                const { toolName, toolCallId, error, input } = lastMessage;
                const serializableError = {
                  cause: error,
                  toolCallId: toolCallId,
                  toolName: toolName,
                  toolArgs: input,
                };

                throw serializableError;
              }
            }
          },
        });
        writer.merge(
          result.toUIMessageStream({
            sendReasoning: true,
          })
        );
      },
      {
        messages: messages,
        tools,
      }
    ),
    onError: errorSerializer((err) => {
      console.error("ai-sdk route: stream error", err);
      return "Oops, an error occured!";
    }),
  });

  return createUIMessageStreamResponse({ stream });
}
