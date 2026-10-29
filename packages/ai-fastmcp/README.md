# @auth0/ai-fastmcp

`@auth0/ai-fastmcp` secures [FastMCP](https://github.com/punkpeye/fastmcp) servers (TypeScript) with Auth0. It is the FastMCP adapter of [`@auth0/ai-mcp`](../ai-mcp): it verifies the access token on every request, answers failures with RFC 6750 challenges, publishes the RFC 9728 protected resource metadata, and hands the verified caller and a request-scoped client to your tools, so a tool can exchange the caller's token for a token to a downstream API.

FastMCP stays the server. This package only fills two of its options.

## Install

```bash
npm install @auth0/ai-fastmcp @auth0/ai-mcp fastmcp
```

`@auth0/ai-mcp` and `fastmcp` are peer dependencies, so your app and this package share one copy of each. The tests run against FastMCP 4.7.0 and the later 4.x releases up to 4.23.8.

## Quickstart

Set the connection details in the environment: `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` (the public URL of your MCP endpoint), and, for token exchanges, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`.

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const auth = createFastMcpAuth({});
const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });

server.addTool({
  name: "list_orders",
  description: "Lists the caller's orders.",
  parameters: z.object({}),
  execute: withAuth0Execute(async (_args, { session }) => `Orders of ${session?.principal.sub}`, {
    requiredScopes: "read:orders",
  }),
});

await server.start({ transportType: "httpStream", httpStream: { port: 3000, stateless: true } });
```

This serves `POST /mcp`, requires a valid Auth0 access token for the audience, and publishes the protected resource metadata. Do not use FastMCP's own `auth` option next to it: that option makes FastMCP an OAuth proxy that issues its own tokens, which is the wrong model for a resource server.

## How it works

`createFastMcpAuth` returns `{ authenticate, oauth }`. Spread both into `new FastMCP({...})`.

- **`authenticate`** is FastMCP's hook. It verifies the Bearer token with the core client, enforces `requiredScopes`, and resolves to a session `{ principal, scopes, mcpClient }`. Every failure is a thrown `Response` with the right status (400, 401, 403 or 500), a generic body and, for authentication failures, a `WWW-Authenticate` challenge that names the metadata document. It never throws anything else: FastMCP would turn a plain error into a 401 that echoes the message.
- **`oauth`** makes FastMCP serve the protected resource metadata at `/.well-known/oauth-protected-resource` and at `/.well-known/oauth-protected-resource<endpoint>`. The document and the challenge are built from the same resource and endpoint, so they cannot drift.

## The session and the accessors

A tool receives the session as `context.session`. It holds `principal` (the verified caller), `scopes` (a plain array, so FastMCP's own `requireScopes` and `canAccess` work on it) and `mcpClient` (a client bound to this caller). It never holds the access token.

`withAuth0Execute(execute, options?)` wraps a tool's `execute`. Inside the wrapped body the accessors of `@auth0/ai-mcp` work, for example `getCallerMcpClientOrThrow()` and `getCallerPrincipal()`. FastMCP has no outer layer where the request context could be bound, so without the wrapper the accessors return `undefined` and you read the session instead. The wrapper changes nothing about argument types: the types FastMCP infers from `parameters` are kept.

```ts
import { getCallerMcpClientOrThrow } from "@auth0/ai-mcp";

server.addTool({
  name: "invoices",
  parameters: z.object({ id: z.string() }),
  execute: withAuth0Execute(async ({ id }) => {
    const { accessToken } = await getCallerMcpClientOrThrow().getTokenOnBehalfOf({
      audience: "https://api.example.com",
      scope: "read:invoices",
    });
    const response = await fetch(`https://api.example.com/invoices/${id}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return await response.text();
  }),
});
```

Token exchange, caching (pass a `tokenStore` such as `MemoryIndexedTokenStore` to enable it), Token Vault and client credentials work as described in the `@auth0/ai-mcp` documentation.

## Scopes

- **Server-wide.** `requiredScopes` on `createFastMcpAuth` applies before any tool runs. A token without one of them gets HTTP 403 with an `insufficient_scope` challenge that lists the missing scopes.
- **Per tool.** `withAuth0Execute(execute, { requiredScopes })`, or `requireScopes(...)` from `@auth0/ai-mcp` inside the body, answers a missing scope with a tool error that names it, for example `Missing required scope: admin:all`. The HTTP status is 200 and the result has `isError: true`. The tool stays listed.
- **Hiding a tool.** FastMCP's own `canAccess: requireScopes("admin:all")` is the alternative. It removes the tool from the list for callers without the scope and answers a direct call with a JSON-RPC `Unknown tool` error, so the client cannot learn which scope it is missing.

## Errors inside tools

FastMCP copies the message of an error thrown by a tool into the result, so a message with a secret in it reaches the client. `withAuth0Execute` closes that gap: a missing scope, a downscoped exchange and an authentication error become fixed texts, and every other error becomes `Tool execution failed.` with `isError: true`. Pass `onError` to see the original error on the server. A FastMCP `UserError` passes through unchanged, because FastMCP defines it as the error meant for the user.

Errors from `session.mcpClient` are already sanitized by `@auth0/ai-mcp`. Tools you do not wrap keep FastMCP's behavior.

## Configuration

Configure the client in one of three ways, the same three as the `@auth0/ai-mcp` handler. Passing `client` together with an inline client option throws `InvalidConfigurationError`.

| Tier | Example |
| --- | --- |
| A client you built | `createFastMcpAuth({ client })` with `client` from `createMcpClient` |
| Inline options | `createFastMcpAuth({ domain, audience, clientId, clientSecret, tokenStore })`. Anything you leave out of `domain`, `audience`, `clientId` and `clientSecret` is read from the environment. |
| Environment | `createFastMcpAuth({})` reads `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`. |

Other options:

| Option | Meaning |
| --- | --- |
| `resource` | The public URL of the server. Defaults to the audience and must equal it. Its path must be empty or equal `endpoint`. |
| `endpoint` | The path FastMCP serves the MCP route on. Defaults to `/mcp`. Pass the same value to `server.start({ httpStream: { endpoint } })`. |
| `authorizationServers` | Issuer URLs for the metadata. Defaults to `https://<domain>/`. |
| `requiredScopes` | Scopes every request must carry. |
| `realm` | The `realm` of challenges. |
| `metadata` | `scopesSupported`, `resourceName` and `resourceDocumentation` for the metadata document. |
| `sessionBinding` | See below. |
| `onError` | Called with the raw error whenever `authenticate` answers 500. |

Behind a proxy, set the audience (and so the resource) to the public URL. FastMCP does not follow `X-Forwarded-*` headers when it serves the metadata.

## Stateless and stateful servers

Run FastMCP with `stateless: true`. Every request is then authenticated on its own and no session id exists.

FastMCP also offers stateful sessions, and then `authenticate` runs on every request, but FastMCP accepts a second valid token on another caller's `mcp-session-id` and runs the call as the new caller. Nothing ties a session id to the subject that created it. `createFastMcpAuth` therefore binds each session id to the subject that used it first and answers any other subject with 403. The binding:

- applies only to requests that carry a session id, and is on by default (`sessionBinding: false` turns it off);
- lives in the memory of one process, so it does not span several instances, and a restart forgets it;
- has limits: `sessionBinding: { maxSessions, ttlMs }` sets them (10000 ids and one hour of idle time by default), and the least recently used id goes first;
- cannot bind the first request of a session, which has no id yet.

For a deployment with several instances, use stateless mode.

## Limits

- **Bearer tokens only.** A request that carries a `DPoP` header, and a token that is bound to a key (a `cnf` claim), both get a 401 and a Bearer challenge. The adapter never accepts such a token as a plain Bearer token. `createFastMcpAuth` throws for a client that requires DPoP mode. The metadata document does not mention DPoP.
- **Protocol revisions.** The tests verify FastMCP with the revisions 2025-03-26, 2025-06-18 and 2025-11-25. FastMCP answers an initialize request for a newer revision with 2025-11-25.
- **Public routes.** FastMCP serves `/health`, `/ready` and the metadata routes without authentication. In stateless mode it answers `GET` and `DELETE` on the MCP route with 405 before `authenticate` runs.
- **Discovery and key outages.** When the tenant's discovery or key endpoints cannot be reached, the adapter answers the way the core client reports it, today with a 401 `invalid_token`.
- **FastMCP releases often.** The peer range is `^4.7.0`. Releases before 4.7.0 reject the `_meta` field of the tool errors this package returns.
- **Unwrapped tools.** The accessors of `@auth0/ai-mcp` only work inside `withAuth0Execute`. Resources and prompts get the session as FastMCP passes it.

## Feedback

Report problems and ask questions in the [auth0-ai-js issues](https://github.com/auth0/auth0-ai-js/issues).
