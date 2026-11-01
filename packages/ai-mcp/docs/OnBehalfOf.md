# On Behalf Of and client credentials

A tool often needs to call a downstream API as the user who invoked it. Forwarding the incoming token would be wrong: Auth0 issued it for your MCP server, not for the downstream API. The On Behalf Of exchange (RFC 8693) trades the caller's token for a new token with the downstream API as its audience. The new token keeps the caller's identity.

## Prerequisites

- `clientId` and `clientSecret` on `createMcpClient`, for an application that may perform the exchange. In your Auth0 tenant that takes four things:
  - The exchange is enabled on the tenant. This may need Auth0 support.
  - The application is a Custom API client tied to your MCP API, with the profile allowed on it (`token_exchange.allow_any_profile_of_type` contains `on_behalf_of_token_exchange`). A regular application cannot exchange tokens.
  - The client has a client grant to each downstream API, with `subject_type` set to `user` and the scopes you will request.
  - Each downstream API allows the exchange without user consent (`skip_consent_for_verifiable_first_party_clients`).

  [Set up your tenant](https://github.com/auth0/auth0-ai-js/tree/main/examples/ai-mcp-server#set-up-your-tenant) in the example README has a command for each step. When one is missing the tool sees only a generic failure, so read the reason in the tenant logs.
- A request context. The exchange is available on the request-scoped client, which the handler binds to the request.

## Exchanging the caller's token

```ts
import { getCallerMcpClientOrThrow } from '@auth0/ai-mcp';

export async function listReports(): Promise<unknown> {
  const mcpClient = getCallerMcpClientOrThrow();
  const token = await mcpClient.getTokenOnBehalfOf({
    audience: 'https://reports-api.example.com',
    scope: 'read:reports',
  });

  const response = await fetch('https://reports-api.example.com/reports', {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  return response.json();
}
```

`getTokenOnBehalfOf` takes:

| Option | Description |
| --- | --- |
| `audience` | Identifier of the downstream API the new token is for. |
| `scope` | Space-separated scopes to request. Optional for the package, but pass the scopes the downstream API needs: see below. |

It resolves to an `OnBehalfOfTokenResult`:

| Field | Description |
| --- | --- |
| `accessToken` | The token for the downstream API. |
| `expiresAt` | Expiry in epoch seconds. |
| `scope` | The scope string exactly as the authorization server returned it. Absent when the server omitted it. |
| `grantedScopes` | The scopes that were actually granted, normalized, deduplicated and sorted. Always present. |
| `tokenType`, `issuedTokenType` | Token type values returned by the exchange, when present. |

Use `grantedScopes`, not `scope`, to decide what a token covers. The token response is read the way RFC 6749 section 5.1 defines it:

- **`scope` absent.** The server omitted the field, which the RFC allows only when the grant is identical to the request. `grantedScopes` holds the normalized requested scopes.
- **`scope` empty (`""`).** Nothing was granted, and `grantedScopes` is empty. When you requested scopes, this is a narrowed grant and the call fails as described below. A truthiness test on `scope` would misread it as a full grant.

The same rule applies to client credentials grants.

The request-scoped client also rejects a result whose `expiresAt` is at or before the current time, or is not a finite number. This applies to `getTokenOnBehalfOf`, `getClientCredentialsToken` and `getTokenForConnection`. The rejection is the generic `The token operation failed.` error, and no token data is attached to it, so a tool never receives a token that is already dead. A cached on behalf of entry that has expired is a miss, so the next call performs a new exchange.

## Narrowed grants

Auth0 can grant fewer scopes than you asked for. When you request scopes and the grant does not include all of them, `getTokenOnBehalfOf` throws `DownscopedTokenError`, so a tool never runs with less authority than it asked for. The error carries no scope data. On `createMcpSdkHandler` and `createNodeMcpHandler`, the MCP SDK turns the error into a tool result with `isError: true` that carries the error's message, which is generic for this error, and the response stays HTTP 200. A 403 `insufficient_scope` is sent only when the error escapes a custom `createMcpHandler` handler.

The narrower token is still cached under the scopes it was actually granted. A later, narrower request can reuse it. See [Token caching](./TokenCaching.md).

When you request no scopes, the package enforces nothing and returns whatever Auth0 granted. On the tenant we tested, an exchange that sends no `scope` is granted none: the response has no `scope` field and the token has no `scope` claim. The exchange does not fall back to the scopes of the client grant, as a client credentials request does. A downstream API that checks scopes then refuses the token, and the package does not complain, so always pass the `scope` the downstream API needs.

```ts
import { DownscopedTokenError, getCallerMcpClientOrThrow } from '@auth0/ai-mcp';

export async function tryExchange(): Promise<string | undefined> {
  try {
    const token = await getCallerMcpClientOrThrow().getTokenOnBehalfOf({
      audience: 'https://reports-api.example.com',
      scope: 'read:reports write:reports',
    });
    return token.accessToken;
  } catch (error) {
    if (error instanceof DownscopedTokenError) {
      return undefined;
    }
    throw error;
  }
}
```

## Concurrent requests

Concurrent identical exchanges from one `McpClient` share a single request to Auth0. Two exchanges are identical when they would be cached under the same key: the same caller, session, downstream audience and scope set. The package does not remember the shared outcome once it settles, so the next call retries after a failure. Each caller receives its own copy of the result.

## Errors from the exchange

Errors leave the request-scoped client with a fixed generic message. The original error is kept as `cause` for server-side diagnostics and must not be serialized into a response. Core errors keep their class, so `instanceof` checks against the error classes of `@auth0/auth0-api-js` still work. Read the `code`, `statusCode` and `headers` of the failure from `cause`. The exception is `VerifyAccessTokenError`: when the exchange re-checks the caller's token and finds that it has expired or is about to expire, it reports `UnauthenticatedError` (HTTP 401 when it reaches the handler). The re-check runs when a `tokenStore` is set. Without a store, Auth0 refuses an expired token and the call fails with the generic error; see [known limitations](./KnownLimitations.md#a-token-in-its-last-seconds-passes-the-gate-but-may-not-be-exchanged). Catch these in your tool and return an `isError` result, as the example in [Examples](../EXAMPLES.md) does.

## Timeouts

Each outbound HTTP request the client makes (the token exchange, discovery and JWKS fetches) is aborted after `requestTimeoutMs`, which defaults to 10 seconds:

```ts
import { createMcpClient } from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'example.auth0.com',
  audience: 'https://mcp.example.com',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  requestTimeoutMs: 5_000,
});
```

The value must be a finite number greater than 0 and at most 2147483647. The limit covers the response body as well as the headers. When a token exchange times out, the underlying call is cancelled, nothing is cached, and every caller that shared that exchange fails with the same error. The next call starts a fresh exchange. The failure is a server error, so `createMcpHandler` answers 500 and never a 401 challenge. Discovery and JWKS fetches are bounded by the same limit, but their failure reaches you as a token verification failure: a request whose discovery or JWKS fetch times out currently gets 401 `invalid_token`, not 500. The limit applies to the client the package builds. If you pass your own `apiClient`, set a `customFetch` on it instead; combining `apiClient` with `requestTimeoutMs` throws `InvalidConfigurationError`.

## Client credentials

`getClientCredentialsToken` obtains a token for the server itself, using its own client credentials, with no caller involved. Use it when the tool acts as the service, for example to call an internal API that is not user-scoped.

```ts
import { getCallerMcpClientOrThrow } from '@auth0/ai-mcp';

export async function readConfig(): Promise<string> {
  const mcpClient = getCallerMcpClientOrThrow();
  const token = await mcpClient.getClientCredentialsToken({
    audience: 'https://internal-api.example.com',
    scope: 'read:config',
  });
  return token.grantedScopes.join(' ');
}
```

The result is the core `TokenSet` (`accessToken`, `expiresAt`, `scope`, `tokenType`) plus `grantedScopes`. When the server returned no `scope` field, `grantedScopes` holds the normalized requested scopes. An empty `scope` string means nothing was granted, and `grantedScopes` is empty. A client credentials grant that is narrower than requested is a server-side configuration failure, because the scopes belong to the server's own client and the caller cannot fix them. It is a generic error with the downscope detail as its `cause`, not a 403. In a custom `createMcpHandler` handler it escapes as a generic 500 and `onError` receives it. With `createMcpSdkHandler` and `createNodeMcpHandler`, the MCP SDK turns it into a tool result with `isError: true` and HTTP 200, and `onError` is not called, so alerts on 5xx or on `onError` never see it. Log it inside the tool. See [Errors](./Errors.md#what-the-handler-returns).

This package does not cache client credentials tokens.
