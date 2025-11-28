import {
  createUIMessageStream,
  UIMessage,
  AISDKError,
  createUIMessageStreamResponse,
} from "ai";
import { toUIMessageStream } from "@ai-sdk/llamaindex";
import { ReActAgent, Settings } from "llamaindex";

import {
  checkUsersCalendar,
  listChannels,
  listRepositories,
} from "@/app/(llamaindex)/lib/tools/";
import { setAIContext } from "@auth0/ai-llamaindex";
import { withInterruptions } from "@auth0/ai-llamaindex/interrupts";
import { errorSerializer } from "@auth0/ai-vercel/interrupts";
import { openai } from "@llamaindex/openai";

// Configure OpenAI LLM
Settings.llm = openai({
  model: "gpt-4o-mini",
});

export async function POST(request: Request) {
  const { id, messages }: { id: string; messages: UIMessage[] } =
    await request.json();

  setAIContext({ threadID: id });

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: withInterruptions(
      async ({ writer }) => {
        const agent = new ReActAgent({
          systemPrompt: `You are an AI assistant. The current date and time is ${new Date().toISOString()}.`,
          tools: [checkUsersCalendar(), listChannels(), listRepositories()],
          verbose: true,
        });
        const stream = await agent.chat({
          message: (messages[messages.length - 1].parts[0] as any)?.text,
          stream: true,
        });

        writer.merge(toUIMessageStream(stream as any));
      },
      {
        messages: messages as any,
        errorType: AISDKError
      }
    ),
    onError: errorSerializer((err) => {
      console.log(err);
      return "Oops, an error occured!";
    }),
  });
    return createUIMessageStreamResponse({ stream });
}


