import { jwtDecode } from "jwt-decode";
import { z } from "zod/v3";

import { getDeviceAuthorizerCredentials } from "@auth0/ai-langchain";
import { tool } from "@langchain/core/tools";
import { LangGraphRunnableConfig } from "@langchain/langgraph";

/**
 * This is an example tool that calls an API using an access token
 * from the context.
 */
export const profileTool = tool(
  async (input, config: LangGraphRunnableConfig) => {
    //Note: this is not validating the signature.
    // A better aproach is to call the userinfo endpoint with the idtoken
    // to get the user profile.
    const credentials = getDeviceAuthorizerCredentials();
    const claims = jwtDecode(credentials?.idToken!);
    return JSON.stringify(claims, null, 2);
  },
  {
    name: "profile_tool",
    description: "Use this to get the user profile (name, email, etc)",
    schema: z.object({}),
  }
);
