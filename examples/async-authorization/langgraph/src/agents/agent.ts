import {
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { AIMessage } from "@langchain/langgraph-sdk";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";

import { conditionalTrade, tradeTool } from "./tools";

const model = new ChatOpenAI({
  model: "gpt-4o",
}).bindTools([tradeTool, conditionalTrade]);

const callLLM = async (state: typeof MessagesAnnotation.State) => {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
};

function shouldContinue(state) {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1] as AIMessage;

  if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) {
    return END;
  }

  return "tools";
}

const stateGraph = new StateGraph(MessagesAnnotation.spec)
  .addNode("callLLM", callLLM)
  .addNode("tools", new ToolNode([conditionalTrade, tradeTool]))
  .addEdge(START, "callLLM")
  .addEdge("tools", "callLLM")
  .addConditionalEdges("callLLM", shouldContinue);

const checkpointer = new MemorySaver();

export const graph = stateGraph.compile({
  checkpointer,
});
