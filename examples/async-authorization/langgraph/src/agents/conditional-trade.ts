import { Auth0AI } from "@auth0/ai-langchain";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import {
  Annotation,
  END,
  InMemoryStore,
  LangGraphRunnableConfig,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { SchedulerClient } from "../services/client";
import { tradeTool } from "./tools";

type ConditionalTrade = {
  ticker: string;
  qty: number;
  metric: string;
  threshold: number;
  operator: string;
};

const checkpointer = new MemorySaver();
const store = new InMemoryStore();

async function shouldContinue(state) {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1] as AIMessage;
  if (
    !lastMessage ||
    !lastMessage.tool_calls ||
    lastMessage.tool_calls.length === 0
  ) {
    return END;
  }

  return "tools";
}

/**
 * Checks the condition of a given state and config, and performs actions based on the status.
 *
 * @param state - The current state object containing task information.
 * @param config - The configuration object for LangGraphRunnable, containing the store.
 * @returns A promise that resolves to the updated state or an object containing messages with tool calls.
 *
 * @see {@link https://langchain-ai.github.io/langgraphjs/how-tos/force-calling-a-tool-first/#define-the-graph}
 */
async function checkCondition(state, config: LangGraphRunnableConfig) {
  const conditionMet = Math.random() >= 0.5;

  if (conditionMet) {
    console.log(`Condition is met! stopping the scheduler`);
    await SchedulerClient().stop(config.configurable?.taskId);
  } else {
    console.log(`Condition is not met! continuing the scheduler`);
    return;
  }

  // Calling the trade tool to initiate the trade
  return {
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "trade_tool",
            args: {
              ticker: state.data.ticker,
              qty: state.data.qty,
            },
            id: "tool_abcd123",
          },
        ],
      }),
    ],
  };
}

/**
 * Notifies the user about the trade.
 *
 * @param {any} state - The current state of the trade.
 * @returns {any} The updated state after notification.
 */
function notifyUser(state) {
  console.log("----");
  console.log(`Notifying the user about the trade.`);
  console.log("----");
  return state;
}

const auth0AI = new Auth0AI();

const protectTool = auth0AI.withAsyncAuthorization({
  audience: process.env["AUDIENCE"]! as string,
  scopes: ["stock:trade"],
  bindingMessage: async (_) => {
    return `Do you want to buy ${_.qty} ${_.ticker}`;
  },
  userID: (_params, config) => {
    return config.configurable?.user_id;
  },
  onUnauthorized(err: Error) {
    return { error: `Unauthorized ${err.message}`, success: false };
  },
});

// Define the state annotation
const StateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  data: Annotation<ConditionalTrade>(),
});

const stateGraph = new StateGraph(StateAnnotation)
  .addNode("checkCondition", checkCondition)
  .addNode("notifyUser", notifyUser)
  .addNode(
    "tools",
    new ToolNode([protectTool(tradeTool)], {
      handleToolErrors: false,
    })
  )
  .addEdge(START, "checkCondition")
  .addConditionalEdges(
    "tools",
    (state) => {
      const lastMessage = state.messages[
        state.messages.length - 1
      ] as AIMessage;
      if (
        lastMessage instanceof ToolMessage &&
        lastMessage.name === "trade_tool" &&
        typeof lastMessage.content === "string"
      ) {
        const { success } = JSON.parse(lastMessage.content);
        return success ? "notifyUser" : END;
      }
      return END;
    },
    [END, "notifyUser"]
  )
  .addConditionalEdges("checkCondition", shouldContinue, [END, "tools"]);

export const graph = stateGraph.compile({
  checkpointer,
  store,
});
