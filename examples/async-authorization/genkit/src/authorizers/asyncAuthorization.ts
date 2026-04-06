import { jwtDecode } from "jwt-decode";

import { Auth0AI, getDeviceAuthorizerCredentials } from "@auth0/ai-genkit";
import { AccessDeniedInterrupt } from "@auth0/ai/interrupts";

import { ai } from "../ai";

const auth0AI = new Auth0AI({
  genkit: ai,
});

export const useAsyncAuthz = auth0AI.withAsyncAuthorization({
  userID: () => {
    const deviceCreds = getDeviceAuthorizerCredentials();
    if (!deviceCreds?.idToken) {
      throw new Error("set the device flow first");
    }
    const { sub } = jwtDecode(deviceCreds.idToken);
    return sub as string;
  },
  bindingMessage: async ({ ticker, qty }) =>
    `Do you want to buy ${qty} shares of ${ticker}`,
  scopes: ["openid", "stock:trade"],
  audience: process.env["AUDIENCE"]!,

  /**
   * When this flag is set to `block`, the execution of the tool awaits
   * until the user approves or rejects the request.
   *
   * Given the asynchronous nature of the Async Authorization flow, this mode
   * is only useful during development.
   *
   * In practice, the process that is awaiting the user confirmation
   * could crash or timeout before the user approves the request.
   *
   * For a more real world scenario refer to `demos/vercel-ai-agent`.
   */
  onAuthorizationRequest: async (authReq, creds) => {
    console.log(`An authorization request was sent to your mobile device or your email.`);
    await creds;
    console.log(`Thanks for approving the order.`);
  },

  onUnauthorized: async (e: Error) => {
    if (e instanceof AccessDeniedInterrupt) {
      return "The user has denied the request";
    }
    return e.message;
  },
});
