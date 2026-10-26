# On Behalf Of and client credentials

A tool often needs to call a downstream API as the user who invoked it. Forwarding the incoming token would be wrong: Auth0 issued it for your MCP server, not for the downstream API. The On Behalf Of exchange (RFC 8693) trades the caller's token for a new token with the downstream API as its audience. The new token keeps the caller's identity.

## Prerequisites

- `clientId` and `clientSecret` on `createMcpClient`. The application must be allowed to perform the exchange in your Auth0 tenant. See the [Auth0 documentation](https://auth0.com/docs) for how to enable it.
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
| `scope` | Optional, space-separated scopes to request. |

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

## Narrowed grants

Auth0 can grant fewer scopes than you asked for. When you request scopes and the grant does not include all of them, `getTokenOnBehalfOf` throws `DownscopedTokenError`, so a tool never runs with less authority than it asked for. The error carries no scope data. On `createMcpSdkHandler` and `createNodeMcpHandler`, the MCP SDK turns the error into a sanitized tool result with `isError: true` and the response stays HTTP 200. A 403 `insufficient_scope` is sent only when the error escapes a custom `createMcpHandler` handler.

The narrower token is still cached under the scopes it was actually granted. A later, narrower request can reuse it. See [Token caching](./TokenCaching.md).

When you request no scopes, the package enforces nothing and returns whatever Auth0 granted.

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

Errors leave the request-scoped client with a fixed generic message. The original error is kept as `cause` for server-side diagnostics and must not be serialized into a response. Core errors keep their class, `code`, `statusCode` and `headers`, so `instanceof` checks against the error classes of `@auth0/auth0-api-js` still work. Catch these in your tool and return an `isError` result, as the example in [Examples](../EXAMPLES.md) does.

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

The result is the core `TokenSet` (`accessToken`, `expiresAt`, `scope`, `tokenType`) plus `grantedScopes`. When the server returned no `scope` field, `grantedScopes` holds the normalized requested scopes. An empty `scope` string means nothing was granted, and `grantedScopes` is empty. A client credentials grant that is narrower than requested is a server-side configuration failure, because the scopes belong to the server's own client and the caller cannot fix them. It surfaces as a generic 500 through `onError`, with the downscope detail as the error's `cause`, and not as a 403.

This package does not cache client credentials tokens.
