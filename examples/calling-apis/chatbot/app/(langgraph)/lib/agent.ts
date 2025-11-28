import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { RunnableLike } from "@langchain/core/runnables";
import {
  END,
  InMemoryStore,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";

import {
  calendarCommunityTool,
  checkUsersCalendar,
  gmailCommunityTool,
  listChannels,
  listRepositories,
} from "./tools";

const model = new ChatOpenAI({
  model: "gpt-4o",
}).bindTools([
  checkUsersCalendar,
  listChannels,
  listRepositories,
  calendarCommunityTool,
  gmailCommunityTool,
]);

// Example of how to access authenticated user context in a node
// The auth handler returns user data that can be accessed via config.configurable.auth
const callLLM = async (
  state: typeof MessagesAnnotation.State,
  config?: any,
) => {
  // Ensure messages array exists
  if (!state.messages) {
    console.log("⚠️ No messages in state, initializing empty array");
    state.messages = [];
  }

  // Access authenticated user data from the standard LangGraph location
  const authenticatedUser = config?.configurable?.langgraph_auth_user;
  if (authenticatedUser) {
    console.log("👤 Authenticated user found:", authenticatedUser);

    // Add user context to the system message if not already present
    const hasSystemMessage = state.messages.some(
      (msg) => msg._getType() === "system",
    );
    if (!hasSystemMessage) {
      const userContext = `You are authenticated as ${authenticatedUser.sub} via Auth0.`;

      // Add a system message with user context
      const systemMessage = new SystemMessage({
        content: [
          {
            type: "text",
            text: `${userContext} The user has the following scopes: ${authenticatedUser.scope || "none"}.`,
          },
          {
            type: "text",
            text: `The current date and time is ${new Date().toISOString()}.`,
          },
        ],
      });
      state.messages.unshift(systemMessage);
    }
  } else {
    console.log(
      "❌ No authenticated user found in config.configurable.langgraph_auth_user",
    );
  }

  const response = await model.invoke(state.messages);
  return { messages: [response] };
};

const routeAfterLLM: RunnableLike = function (state) {
  // Ensure messages array exists and has content
  if (!state.messages || state.messages.length === 0) {
    return END;
  }

  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  if (!lastMessage.tool_calls?.length) {
    return END;
  }
  return "tools";
};

const stateGraph = new StateGraph(MessagesAnnotation)
  .addNode("callLLM", callLLM)
  .addNode(
    "tools",
    new ToolNode(
      [
        // A tool with token vault access
        checkUsersCalendar,
        // A tool with token vault access
        listChannels,
        // A tool with token vault access
        listRepositories,
        // A community tool with token vault access
        calendarCommunityTool,
        // A community tool with token vault access
        gmailCommunityTool,
      ],
      {
        // Error handler should be disabled in order to
        // trigger interruptions from within tools.
        handleToolErrors: false,
      },
    ),
  )
  .addEdge(START, "callLLM")
  .addConditionalEdges("callLLM", routeAfterLLM, [END, "tools"])
  .addEdge("tools", "callLLM");

const checkpointer = new MemorySaver();
const store = new InMemoryStore();

export const graph = stateGraph.compile({
  checkpointer,
  store,
  interruptBefore: [],
  interruptAfter: [],
});
