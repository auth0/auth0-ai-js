# Errors and status codes

Failures reach the caller in two ways. A request that does not pass authentication gets an HTTP error response from `authenticate`. A tool that fails after authentication gets an ordinary tool result with `isError: true` and the HTTP status 200.

## Authentication failures

`authenticate` fails by throwing a `Response`, which FastMCP sends to the client as it is. It never throws anything else, because FastMCP would turn another error into a 401 that repeats its message. Every body is JSON with an `error` and an `error_description`, and every response has `cache-control: no-store`.

| Status | `error` | `error_description` | When |
| --- | --- | --- | --- |
| 400 | `invalid_request` | `The request is malformed.` | The `Authorization` header is malformed, for example `Bearer a b`. |
| 400 | `invalid_request` | `The session id is not valid.` | The `mcp-session-id` header is longer than 256 characters. |
| 401 | `unauthorized` | `Authentication is required.` | There is no `Authorization` header, or it uses a scheme other than Bearer. |
| 401 | `invalid_token` | `The access token is invalid or has expired.` | The token failed verification: bad signature, expired, wrong audience or issuer, no `sub`, or an organization policy violation. |
| 401 | `invalid_token` | `DPoP is not supported by this server.` | The request has a `DPoP` header. See [DPoP](./DPoP.md). |
| 401 | `invalid_token` | `DPoP-bound access tokens are not supported by this server.` | The token has a `cnf` claim. |
| 403 | `insufficient_scope` | `The access token does not include the required scope.` | The token lacks a scope of `requiredScopes`. |
| 403 | `forbidden` | `The session belongs to a different caller.` | Another subject used the session id first. See [Stateless and stateful servers](./StatelessAndStateful.md). |
| 500 | `server_error` | `Internal server error.` | The adapter or the client failed in a way that is not the caller's fault. |

The 400 for an over-long session id, the 403 for a session mismatch and the 500 have no `WWW-Authenticate` header. All the others do, and it names the metadata document, for example:

```text
WWW-Authenticate: Bearer error="invalid_token", error_description="The access token is invalid or has expired.", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
```

Details of the challenges:

- The 401 for a missing credential has no `error` value, as RFC 6750 asks, so the header reads `Bearer resource_metadata="..."`.
- The 403 for a missing scope adds `scope="..."`, which lists only the scopes the token lacks.
- A `realm` option adds `realm="..."` to each challenge.
- Challenges name the `Bearer` scheme only.

The descriptions are fixed. A verification failure always gets the same text, whatever the cause, so the response does not help someone probing for tokens. To learn the cause of a 401 yourself, see [Troubleshooting](./Troubleshooting.md#401-and-invalid_token-with-a-token-that-looks-fine).

### 500 and onError

A 500 means something on the server failed: a thrown error that is not an authentication error, a client that raised an unexpected fault. The body never names the cause. `onError` receives the raw error, so log it there.

### A tenant that cannot be reached

When the discovery or key endpoints of the tenant cannot be reached, the core client reports it as a failed verification, so the caller gets the 401 `invalid_token` above and `onError` does not run. A burst of 401s for tokens that are valid is the sign to look at connectivity to the tenant.

## Errors inside tools

FastMCP copies the message of an error thrown by a tool into the tool result. A tool that is not wrapped therefore sends the message of every error to the client, including one with a secret in it. `withAuth0Execute` replaces the message with a fixed text, so nothing from the original error reaches the client.

| Text | `_meta.error` | When |
| --- | --- | --- |
| `Missing required scope: refund:orders` | `insufficient_scope` | The caller lacks a scope of the tool's `requiredScopes`, or `requireScopes` from `@auth0/ai-mcp` inside the function failed. Several missing scopes read `Missing required scopes: a, b`. |
| `The token exchange did not grant the requested scopes.` | `insufficient_scope` | A token exchange succeeded but the tenant granted fewer scopes than the tool asked for. |
| `Authentication is required.` | `invalid_token` | The wrapper found no session, or an `UnauthenticatedError` of `@auth0/ai-mcp` escaped. |
| `The token operation failed.` | `server_error` | An `AuthError`, the class `@auth0/ai-mcp` exports, escaped the function. |
| `Tool execution failed.` | `server_error` | Any other error, including an exchange that the tenant refused or that could not be reached. |

All of these results have `isError: true` and the HTTP status 200. The error `_meta` is what a program can read; the text is for a person.

One kind of error is not replaced: a FastMCP `UserError`. FastMCP defines it as the error whose message is meant for the user, so the wrapper passes it through and the client sees its message. Do not put secrets in a `UserError`.

For every row except the first three, `withAuth0Execute` hands the raw error to its `onError` option:

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const server = new FastMCP({ name: "orders", version: "1.0.0", ...createFastMcpAuth({}) });

server.addTool({
  name: "invoices",
  parameters: z.object({}),
  execute: withAuth0Execute(
    async (_args, { session }) => {
      const { accessToken } = await session.mcpClient.getTokenOnBehalfOf({ audience: "https://api.example.com" });
      return accessToken.length > 0 ? "ok" : "empty";
    },
    { onError: (error) => console.error("invoices failed", error instanceof Error ? error.name : "unknown") },
  ),
});
```

The hook runs on the server and the wrapper ignores its return value. The wrapper also ignores a hook that throws or returns a rejected promise.

## Errors from the request-scoped client

`@auth0/ai-mcp` sanitizes errors thrown by `session.mcpClient` before they reach your code: it replaces the message with `The token operation failed.` and attaches the original error as `cause`. Do not send `cause` to a client. Whatever your function lets escape is then mapped by the table above.

## Configuration errors

Mistakes in the options throw `InvalidConfigurationError` from `createFastMcpAuth`, when you call it. [Troubleshooting](./Troubleshooting.md#the-server-does-not-start) lists the messages.
