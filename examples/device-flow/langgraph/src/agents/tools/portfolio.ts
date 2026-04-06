import { z } from "zod/v3";

import { getDeviceAuthorizerCredentials } from "@auth0/ai-langchain";
import { tool } from "@langchain/core/tools";
import { LangGraphRunnableConfig } from "@langchain/langgraph";

/**
 * This is an example tool that calls an API using an access token
 * from the context.
 */
export const portfolioTool = tool(
  async (input, config: LangGraphRunnableConfig) => {
    // Get the access token
    let accessToken: string | undefined = undefined;

    if (config.configurable?.accessToken) {
      accessToken = config.configurable.accessToken;
    } else {
      const credentials = getDeviceAuthorizerCredentials();
      accessToken = credentials?.accessToken;
    }

    if (!accessToken) {
      return `Authorization error - Trade FAILED.`;
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
    };

    const url = `${process.env["API_URL"]!}portfolio`;

    const response = await fetch(url, {
      method: "GET",
      headers: headers,
    });

    const body = await response.json();

    return JSON.stringify(body, null, 2);
  },
  {
    name: "portfolio_tool",
    description: "Use this function to get the users portfolio",
    schema: z.object({}),
  }
);
