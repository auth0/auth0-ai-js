import "dotenv/config";

import Enquirer from "enquirer";
import terminalLink from "terminal-link";

import { login } from "@auth0/auth0-ai-js-tools-login-helper";
import { HumanMessage } from "@langchain/core/messages";
import { Client, Thread } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: process.env.LANGGRAPH_API_URL || "http://localhost:54367",
});

const langGraphStudioURL = (thread: Thread) => {
  const searchParams = new URLSearchParams({
    baseUrl: process.env.LANGGRAPH_API_URL || "http://localhost:54367",
  });
  return `https://smith.langchain.com/studio/thread/${thread.thread_id}?${searchParams}`;
};

async function main() {
  const { user, accessToken } = await login({
    authParams: {
      scope: "openid profile email stock:trade",
      audience: process.env.AUDIENCE,
    },
  });

  const thread = await client.threads.create();

  console.log(`Welcome ${user.name ?? user.email} to the demo chatbot!`);
  console.log(`Thread ID: ${thread.thread_id}`);
  console.log(
    `Check this thread in LangGraph studio ${terminalLink("here", langGraphStudioURL(thread))}`
  );
  console.log(`<Enter a command (type "exit" to quit)>\n`);

  const enquirer = new Enquirer<{ prompt: string }>();

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

      const stream = client.runs.stream(thread.thread_id, "agent", {
        // streamMode: "messages",
        streamMode: "events",
        input: {
          messages: [new HumanMessage(prompt)],
        },
        config: {
          configurable: {
            user_id: user.sub,
            accessToken: accessToken,
          },
        },
      });

      process.stdout.write("Assistant · ");
      for await (const message of stream) {
        if (
          message.event === "events" &&
          message.data &&
          message.data["event"] === "on_chat_model_stream"
        ) {
          const content = message.data["data"]["chunk"]["content"];
          if (!content) {
            continue;
          }
          process.stdout.write(content);
        }
      }
      process.stdout.write("\n");
    }
  } catch (error) {
    console.dir(error);
    console.log("AGENT:error", error);
    process.exit(1);
  }
}

main().catch(console.error);
