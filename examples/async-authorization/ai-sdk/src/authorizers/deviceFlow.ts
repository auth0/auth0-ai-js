import Enquirer from "enquirer";
import open from "open";

import { Auth0AI } from "@auth0/ai-vercel";

const confirm = new Enquirer<{ answer: boolean }>();

// we use another the public client for this authorizer
export const useDeviceFLow = new Auth0AI({
  auth0: {
    domain: process.env.AUTH0_DOMAIN!,
    clientId: process.env.AUTH0_PUBLIC_CLIENT_ID!,
  },
}).withDeviceAuthorizationFlow({
  scopes: ["openid"],
  audience: process.env.AUDIENCE!,
  onAuthorizationRequest: async (request) => {
    const { answer } = await confirm.prompt({
      type: "confirm",
      name: "answer",
      initial: true,
      message: `We need to authenticate you in a browser. You will be taken to a login page where this code will be prefilled: ${request.userCode}. Do you want to continue?`,
    });
    if (!answer) {
      process.exit(1);
    }
    await open(request.verificationUriComplete!);
  },
  onUnauthorized: async (e: Error) => {
    return e.message;
  },
});
