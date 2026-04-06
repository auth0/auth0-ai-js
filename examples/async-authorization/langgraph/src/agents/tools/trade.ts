import { z } from "zod/v3";

import { getAsyncAuthorizationCredentials } from "@auth0/ai-langchain";
import { tool } from "@langchain/core/tools";
import { LangGraphRunnableConfig } from "@langchain/langgraph";

/**
 * This is an example tool that calls an API using an access token
 * from the context to trade a stock.
 *
 * In this example this tool can be used directly from the "agent" node,
 * or in the "conditional purchase" agent.
 *
 * In the case is used by the "agent" node, ex. from the chatbot. The access token
 * is attached to the configuration object.
 *
 * In the case is used in the "conditional purchase" agent, the access token is
 * requested using Async Authorization (Client Initiated Backchannel Authentication) by the
 * wrapping authorizer.
 */
export const tradeTool = tool(
  async (input, config: LangGraphRunnableConfig) => {
    // Get the access token
    let accessToken: string | undefined = undefined;

    if (config.configurable?.accessToken) {
      accessToken = config.configurable.accessToken;
    } else {
      const credentials = getAsyncAuthorizationCredentials();
      accessToken = credentials?.accessToken;
    }

    if (!accessToken) {
      return `Authorization error - Trade FAILED.`;
    }

    const headers = {
      Authorization: "",
      "Content-Type": "application/json",
    };
    const body = {
      ticker: input.ticker,
      qty: input.qty,
    };

    if (accessToken === null) {
      throw new Error("Access token not found");
    }

    if (accessToken) {
      headers["Authorization"] = "Bearer " + accessToken;
    }

    const response = await fetch(process.env["API_URL"]!, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    return {
      success: true,
      message: `Trade successful - ${response.statusText} - ${input.ticker} - ${input.qty}`,
      ticker: input.ticker,
      qty: input.qty,
    };
  },
  {
    name: "trade_tool",
    description: "Use this function to trade an stock",
    schema: z.object({
      ticker: z.string(),
      qty: z.number(),
    }),
  }
);
