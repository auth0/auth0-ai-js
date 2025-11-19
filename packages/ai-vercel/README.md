# Auth0 AI for the [AI SDK](https://sdk.vercel.ai/)

`@auth0/ai-vercel` is an SDK for building secure AI-powered applications using [Auth0](https://www.auth0.ai/), [Okta FGA](https://docs.fga.dev/), and [AI SDK](https://sdk.vercel.ai/).

## Features

- **Authorization for RAG**: Securely filter documents using Okta FGA as a [retriever](https://js.langchain.com/docs/concepts/retrievers/) for RAG applications. This smart retriever performs efficient batch access control checks, ensuring users only see documents they have permission to access.

- **Tool Authorization with FGA**: Protect AI tool execution with fine-grained authorization policies through Okta FGA integration, controlling which users can invoke specific tools based on custom authorization rules.

- **Client Initiated Backchannel Authentication (CIBA)**: Implement secure, out-of-band user authorization for sensitive AI operations using the [CIBA standard](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html), enabling user confirmation without disrupting the main interaction flow.

- **Federated API Access**: Seamlessly connect to third-party services by leveraging Auth0's Tokens For APIs feature, allowing AI tools to access users' connected services (like Google, Microsoft, etc.) with proper authorization.

- **Device Authorization Flow**: Support headless and input-constrained environments with the [Device Authorization Flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/device-authorization-flow), enabling secure user authentication without direct input capabilities.


## Install

> [!WARNING]
> `@auth0/ai-vercel` is currently **under heavy development**. We strictly follow [Semantic Versioning (SemVer)](https://semver.org/), meaning all **breaking changes will only occur in major versions**. However, please note that during this early phase, **major versions may be released frequently** as the API evolves. We recommend locking versions when using this in production.

```bash
npm install @auth0/ai @auth0/ai-vercel
```

## Initialization

Initialize the SDK with your Auth0 credentials:

```javascript
import { Auth0AI, setAIContext } from "@auth0/ai-vercel";

const auth0AI = new Auth0AI({
  // Alternatively, you can use the `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET`
  // environment variables.
  auth0: {
    domain: "YOUR_AUTH0_DOMAIN",
    clientId: "YOUR_AUTH0_CLIENT_ID",
    clientSecret: "YOUR_AUTH0_CLIENT_SECRET",
  },
  // store: new MemoryStore(), // Optional: Use a custom store
});
```

Set the ThreadID:

```javascript
setAIContext({
  threadID: "...",
});
```

## Calling APIs

The "Tokens for API" feature of Auth0 allows you to exchange refresh tokens for access tokens for third-party APIs. This is useful when you want to use a token vault (like Google, Facebook, etc.) to authenticate users and then use the access token to call the API on behalf of the user.

First initialize the Token Vault Authorizer as follows:

```javascript
import { auth0 } from "./auth0";

export const withGoogleAccess = auth0AI.withTokenVault({
  // A function to retrieve the refresh token of the context.
  refreshToken: async () => {
    const session = await auth0.getSession();
    const refreshToken = session?.tokenSet.refreshToken!;
    return refreshToken;
  },
  // The connection name.
  connection: 'google-oauth2',
  // The scopes to request.
  scopes: ["openid", "https://www.googleapis.com/auth/calendar.freebusy"],
  // Additional authorization params needed to connect an account (optional).
  authorizationParams: {
    ...
  },
});
```

Then use the `withGoogleAccess` to wrap the tool and use `getAccessTokenFromTokenVault` from the SDK to get the access token.

```javascript
import { tool } from "ai";
import { getAccessTokenFromTokenVault } from "@auth0/ai-vercel";
import { TokenVaultError } from "@auth0/ai/interrupts";
import { addDays } from "date-fns";

export const checkUsersCalendar = withGoogleAccess(
  tool({
    description:
      "Check user availability on a given date time on their calendar",
    parameters: z.object({
      date: z.coerce.date(),
    }),
    execute: async ({ date }) => {
      const accessToken = getAccessTokenFromTokenVault();
      const url = "https://www.googleapis.com/calendar/v3/freeBusy";
      const body = JSON.stringify({
        timeMin: date,
        timeMax: addDays(date, 1),
        timeZone: "UTC",
        items: [{ id: "primary" }],
      });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new TokenVaultError(
            `Authorization required to access the Token Vault`
          );
        }
        throw new Error(
          `Invalid response from Google Calendar API: ${
            response.status
          } - ${await response.text()}`
        );
      }

      const busyResp = await response.json();
      return { available: busyResp.calendars.primary.busy.length === 0 };
    },
  })
);
```

## CIBA: Client-Initiated Backchannel Authentication

CIBA (Client-Initiated Backchannel Authentication) enables secure, user-in-the-loop authentication for sensitive operations. This flow allows you to request user authorization asynchronously and resume execution once authorization is granted.

```javascript
import { auth0 } from "./auth0";

export const buyStockAuthorizer = auth0AI.withAsyncAuthorization({
  // Same parameters passed to the tool execute function
  userID: (params: { userID: string }, ctx) => params.userID,

  // The message the user will see on the notification
  bindingMessage: async ({ qty , ticker }) => {
    return `Confirm the purchase of ${qty} ${ticker}`;
  },
  // Expiration for this request in seconds (default=300s)
  requestedExpiry: 300,
  // The scopes and audience to request
  scope: "openid stock:trade",
  audience: "http://localhost:8081",
});
```

Then wrap the tool as follows:

```javascript
export const purchaseStock = buyStockAuthorizer({
  description: "Execute a stock purchase given stock ticker and quantity",
  parameters: z.object({
    tradeID: z
      .string()
      .uuid()
      .describe("The unique identifier for the trade provided by the user"),
    userID: z
      .string()
      .describe("The user ID of the user who created the conditional trade"),
    ticker: z.string().describe("The stock ticker to trade"),
    qty: z
      .number()
      .int()
      .positive()
      .describe("The quantity of shares to trade"),
  }),
  execute: async ({
    userID,
    ticker,
    qty,
  }: {
    userID: string;
    ticker: string;
    qty: number;
  }): Promise<string> => {
    const credentials = getAsyncAuthorizationCredentials();
    // Use credentials.accessToken to call the stock API.
    return `Just bought ${qty} shares of ${ticker} for ${userID}`;
  },
});
```

### CIBA with RAR (Rich Authorization Requests)
Auth0 supports RAR (Rich Authorization Requests) for CIBA. This allows you to provide additional authorization parameters to be displayed during the user confirmation request.

When defining the tool authorizer, you can specify the `authorizationDetails` parameter to include detailed information about the authorization being requested:

```js
const buyStockAuthorizer = auth0AI.withAsyncAuthorization({
  // A callback to retrieve the userID from tool context.
  userID: (params: { userID: string }, ctx) => params.userID,

  // The message the user will see on the notification
  bindingMessage: async ({ qty , ticker }) => {
    return `Confirm the purchase of ${qty} ${ticker}`;
  },
  // Expiration for this request in seconds (default=300s)
  requestedExpiry: 300,
  authorizationDetails: async ({ qty, ticker }) => {
    return [{ type: "trade_authorization", qty, ticker, action: "buy" }];
  },
  // The scopes and audience to request
  audience: process.env["AUDIENCE"],
  scopes: ["stock:trade"]
});
```

To use RAR with CIBA, you need to [set up authorization details](https://auth0.com/docs/get-started/apis/configure-rich-authorization-requests) in your Auth0 tenant. This includes defining the authorization request parameters and their types. Additionally, the [Guardian SDK](https://auth0.com/docs/secure/multi-factor-authentication/auth0-guardian) is required to handle these authorization details in your authorizer app.

For more information on setting up RAR with CIBA, refer to:
- [Configure Rich Authorization Requests (RAR)](https://auth0.com/docs/get-started/apis/configure-rich-authorization-requests)
- [User Authorization with CIBA](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/user-authorization-with-ciba)

## Device Flow Authorizer

The Device Flow Authorizer enables secure, user-in-the-loop authentication for devices or tools that cannot directly authenticate users. It uses the OAuth 2.0 Device Authorization Grant to request user authorization and resume execution once authorization is granted.

```javascript
import { auth0 } from "./auth0";

export const deviceFlowAuthorizer = auth0AI.withDeviceAuthorizationFlow({
  // The scopes and audience to request
  scopes: ["read:data", "write:data"],
  audience: "https://api.example.com",
});
```

Then wrap the tool as follows:

```javascript
import { tool } from "ai";
import { z } from "zod";
import { getDeviceAuthorizerCredentials } from "@auth0/ai-vercel";

export const fetchData = deviceFlowAuthorizer(
  tool({
    description: "Fetch data from a secure API",
    parameters: z.object({
      resourceID: z.string().describe("The ID of the resource to fetch"),
    }),
    execute: async ({ resourceID }): Promise<any> => {
      const credentials = getDeviceAuthorizerCredentials();
      const response = await fetch(`https://api.example.com/resource/${resourceID}`, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch resource: ${response.statusText}`);
      }

      return await response.json();
    },
  })
);
```

This flow is particularly useful for devices or tools that cannot directly authenticate users, such as IoT devices or CLI tools.

## FGA

```javascript
import { Auth0AI } from "@auth0/ai-vercel";

const auth0AI = new Auth0AI.FGA({
  apiScheme,
  apiHost,
  storeId,
  credentials: {
    method: CredentialsMethod.ClientCredentials,
    config: {
      apiTokenIssuer,
      clientId,
      clientSecret,
    },
  },
});
// Alternatively you can use env variables: `FGA_API_SCHEME`, `FGA_API_HOST`, `FGA_STORE_ID`, `FGA_API_TOKEN_ISSUER`, `FGA_CLIENT_ID` and `FGA_CLIENT_SECRET`
```

Then initialize the tool wrapper:

```javascript
const authorizedTool = fgaAI.withFGA(
  {
    buildQuery: async ({ userID, doc }) => ({
      user: userID,
      object: doc,
      relation: "read",
    }),
  },
  myAITool
);

// Or create a wrapper to apply to tools later
const authorizer = fgaAI.withFGA({
  buildQuery: async ({ userID, doc }) => ({
    user: userID,
    object: doc,
    relation: "read",
  }),
});

const authorizedTool = authorizer(myAITool);
```

Note: the parameters given to the `buildQuery` function are the same provided to the tool's `execute` function.

## Interruptions

This library includes infrastructure code within the AI SDK to handle a concept called **Interruptions**.

In an LLM workflow, a tool call may fail because it requires additional input from the user—a process commonly known as **Human in the Loop**. We refer to this special type of error as an Interruption.

When a tool throws an error that extends the Interruption class, the AI SDK automatically serializes the error and returns it to the client.

The client can then process the interruption, obtain the necessary input, and resume execution within the tool chain.

Read [Setup Interruptions](./SETUP_INTERRUPTIONS.md) for more information.

## Feedback

### Contributing

We appreciate feedback and contribution to this repo! Before you get started, please see the following:

- [Auth0's general contribution guidelines](https://github.com/auth0/open-source-template/blob/master/GENERAL-CONTRIBUTING.md)
- [Auth0's code of conduct guidelines](https://github.com/auth0/open-source-template/blob/master/CODE-OF-CONDUCT.md)

### Raise an issue

To provide feedback or report a bug, please [raise an issue on our issue tracker](https://github.com/auth0/auth0-ai-js/issues).

### Vulnerability Reporting

Please do not report security vulnerabilities on the public GitHub issue tracker. The [Responsible Disclosure Program](https://auth0.com/responsible-disclosure-policy) details the procedure for disclosing security issues.

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.auth0.com/website/sdks/logos/auth0_light_mode.png"   width="150">
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.auth0.com/website/sdks/logos/auth0_dark_mode.png" width="150">
    <img alt="Auth0 Logo" src="https://cdn.auth0.com/website/sdks/logos/auth0_light_mode.png" width="150">
  </picture>
</p>
<p align="center">Auth0 is an easy to implement, adaptable authentication and authorization platform. To learn more checkout <a href="https://auth0.com/why-auth0">Why Auth0?</a></p>
<p align="center">
This project is licensed under the Apache 2.0 license. See the <a href="/LICENSE"> LICENSE</a> file for more info.</p>
