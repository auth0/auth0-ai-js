import { initApiPassthrough } from "langgraph-nextjs-api-passthrough";

import { auth0 } from "@/lib/auth0";

async function getAccessToken() {
  const tokenResult = await auth0.getAccessToken();

  if (!tokenResult?.token) {
    throw new Error("Error retrieving access token for langgraph api.");
  }

  return tokenResult.token;
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, runtime } =
  initApiPassthrough({
    apiUrl: process.env.LANGGRAPH_API_URL,
    apiKey: process.env.LANGSMITH_API_KEY,
    runtime: "edge",
    baseRoute: "langgraph/",
    headers: async () => {
      const accessToken = await getAccessToken();
      return {
        Authorization: `Bearer ${accessToken}`,
      };
    },
  });
