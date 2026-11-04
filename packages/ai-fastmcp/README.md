# @auth0/ai-fastmcp

`@auth0/ai-fastmcp` secures [FastMCP](https://github.com/punkpeye/fastmcp) servers (TypeScript) with Auth0. It is the FastMCP adapter of [`@auth0/ai-mcp`](../ai-mcp): it verifies the access token on every request, answers failures with RFC 6750 challenges, publishes the RFC 9728 protected resource metadata, and hands the verified caller and a request-scoped client to your tools, so a tool can exchange the caller's token for a token to a downstream API.

FastMCP stays the server. This package only fills two of its options.

## Install

```bash
npm install @auth0/ai-fastmcp @auth0/ai-mcp fastmcp
```

`@auth0/ai-mcp` and `fastmcp` are peer dependencies, so your app and this package share one copy of each. The test suite passes against FastMCP 4.22.0, the oldest release supported, and 4.23.8, the newest tested, and against a sample of the releases in between.

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
  execute: withAuth0Execute(async (_args, { session }) => `Orders of ${session.principal.sub}`, {
    requiredScopes: "read:orders",
  }),
});

await server.start({ transportType: "httpStream", httpStream: { port: 3000, stateless: true } });
```

This serves `POST /mcp`, requires a valid Auth0 access token for the audience, and publishes the protected resource metadata. Do not use FastMCP's own `auth` option next to it: that option makes FastMCP an OAuth proxy that issues its own tokens, which is the wrong model for a resource server.

## How it works

`createFastMcpAuth` returns `{ authenticate, oauth }`. Spread both into `new FastMCP({...})`.

- **`authenticate`** is FastMCP's hook. It verifies the Bearer token with the core client, enforces `requiredScopes`, and resolves to a session `{ principal, scopes, mcpClient }`. Every failure is a thrown `Response` with the right status (400, 401, 403 or 500), a generic body and, for authentication failures, a `WWW-Authenticate` challenge that names the metadata document. For an HTTP request it never throws anything else: FastMCP would turn a plain error into a 401 that echoes the message.
- **`oauth`** makes FastMCP serve the protected resource metadata at `/.well-known/oauth-protected-resource` and at `/.well-known/oauth-protected-resource<endpoint>`. The document and the challenge are built from the same resource and endpoint, so they cannot drift.

## The session and the accessors

A tool receives the session as `context.session`. It holds `principal` (the verified caller), `scopes` (a plain array, so FastMCP's own `requireScopes` and `canAccess` work on it) and `mcpClient` (a client bound to this caller). It never holds the access token.

`withAuth0Execute(execute, options?)` wraps a tool's `execute`. Inside the wrapped body the accessors of `@auth0/ai-mcp` work, for example `getCallerMcpClientOrThrow()` and `getCallerPrincipal()`. FastMCP has no outer layer where the request context could be bound, so without the wrapper the accessors return `undefined` and you read the session instead. The wrapper changes nothing about argument types: the types FastMCP infers from `parameters` are kept. Inside the wrapped function `context.session` is typed as always present, so you read `session.principal` without a non-null assertion. FastMCP types the session as optional, but when a call arrives without one the wrapper answers it and never runs your function.

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

- **Server-wide.** `requiredScopes` on `createFastMcpAuth` applies before any tool runs. A token without one of them gets HTTP 403 with an `insufficient_scope` challenge that lists the missing scopes. A request without credentials gets a 401 challenge whose `scope` parameter names all of them, and the metadata document publishes them as `scopes_supported` unless you set `metadata.scopesSupported`, so a client knows which scopes to ask for. Each entry is split on whitespace (`"read write"` is two scopes) and repeats count once. A blank or non-string entry makes `createFastMcpAuth` throw `InvalidConfigurationError`.
- **Per tool.** `withAuth0Execute(execute, { requiredScopes })`, or `requireScopes(...)` from `@auth0/ai-mcp` inside the body, answers a missing scope with a tool error that names it (a blank entry in `requiredScopes` throws `InvalidConfigurationError` when you create the wrapper), for example `Missing required scope: admin:all`. The HTTP status is 200 and the result has `isError: true`. The tool stays listed.
- **Hiding a tool.** FastMCP's own `canAccess: requireScopes("admin:all")` is the alternative. It removes the tool from the list for callers without the scope and answers a direct call with a JSON-RPC `Unknown tool` error, so the client cannot learn which scope it is missing.

## Errors inside tools

FastMCP copies the message of an error thrown by a tool into the result, so a message with a secret in it reaches the client. `withAuth0Execute` closes that gap: a missing scope, a downscoped exchange and an authentication error become fixed texts, and every other error becomes `Tool execution failed.` with `isError: true`. Pass `onError` to see the original error on the server. Without one, each failure writes a single line to the server's standard error stream (not to `context.log`, which FastMCP sends to the client): `[ai-fastmcp] Tool failed: <error name> code=<code> statusCode=<status> auth0_error=<error> auth0_error_description="<text>"`, with the fields that exist, cut to 300 characters on one line. It never holds the message, a token, a header or a request body. A missing scope, a downscoped exchange and a missing session are expected outcomes and are not logged. A 500 from `authenticate` writes the same kind of line, starting `[ai-fastmcp] Authentication failed:`. A FastMCP `UserError` passes through unchanged, because FastMCP defines it as the error meant for the user.

Errors from `session.mcpClient` are already sanitized by `@auth0/ai-mcp`. Tools you do not wrap keep FastMCP's behavior.

## Configuration

Configure the client in one of three ways, the same three as the `@auth0/ai-mcp` handler. Passing `client` together with an inline client option throws `InvalidConfigurationError`, the class `@auth0/ai-mcp` exports.

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
| `requiredScopes` | Scopes every request must carry. Also the default `scopes_supported` and the `scope` of the 401 challenge. |
| `realm` | The `realm` of challenges. |
| `metadata` | `scopesSupported` (defaults to `requiredScopes`), `resourceName` and `resourceDocumentation` for the metadata document. |
| `sessionBinding` | See below. |
| `onError` | Called with the raw error whenever `authenticate` answers 500, and for every tool wrapped with `withAuth0Execute` that has no `onError` of its own (a tool's own `onError` replaces it). The error never reaches the client and can carry Auth0 response details, so treat it as sensitive. While a hook is set, the default log line is not written. A throwing hook is ignored. |

Behind a proxy, set the audience (and so the resource) to the public URL. FastMCP does not follow `X-Forwarded-*` headers when it serves the metadata.

## Stateless and stateful servers

Run FastMCP with `stateless: true`. Every request is then authenticated on its own and no session id exists.

FastMCP also offers stateful sessions, and then `authenticate` runs on every request, but FastMCP accepts a second valid token on another caller's `mcp-session-id` and runs the call as the new caller. Nothing ties a session id to the subject that created it. `createFastMcpAuth` therefore binds each session id to the subject that used it first and answers any other subject with 403. The binding:

- applies only to requests that carry a session id, and is on by default (`sessionBinding: false` turns it off). The adapter cannot tell which mode FastMCP runs in, so a stateless server behind a gateway that forwards a fixed session id binds that id too, and a second user behind the same id gets 403;
- lives in the memory of one process, so it does not span several instances, and a restart forgets it;
- has limits: `sessionBinding: { maxSessions, maxSessionsPerSubject, ttlMs }` sets them (10000 ids, 100 per subject and one hour of idle time by default). When the whole map is full the least recently used id goes first;
- cannot bind the first request of a session, which has no id yet;
- records the id of any request that passes authentication, including ids FastMCP never issued, because `authenticate` runs before FastMCP looks the session up. The per-subject limit keeps one caller from filling the map: a subject that reaches it replaces its own oldest id and cannot push out another subject's. It raises the cost of the attack without ending it, because several accounts together can still fill the map (on a tenant with open sign-up, creating them is cheap). Raise `maxSessionsPerSubject` for a subject that legitimately holds many sessions, such as a gateway;
- forgets an id after `ttlMs` without a request on it, even while FastMCP keeps the session alive. FastMCP does not close a session that has an open event stream, and the token is checked only when the stream opens, so a client that holds a stream open longer than `ttlMs` leaves a live session without a binding, which another subject who knows the id can then take. Set `ttlMs` above the longest stream you expect.

The binding is a mitigation. Stateless mode is the fix: it has no session ids to take over, and it is the right choice for a deployment with several instances.

## Limits

- **Bearer tokens only.** A request that carries a `DPoP` header, and a token that is bound to a key (a `cnf` claim), both get a 401 and a Bearer challenge. The adapter never accepts such a token as a plain Bearer token. `createFastMcpAuth` throws for a client that requires DPoP mode. The metadata document does not mention DPoP.
- **HTTP transports only.** FastMCP calls `authenticate` with no request for the stdio transport, so there is no token to verify. The hook then rejects with an error that tells you to start the server with `transportType: "httpStream"`, FastMCP logs it, and the session stays unset, so wrapped tools answer `Authentication is required.`
- **No legacy SSE transport.** FastMCP runs on mcp-proxy, which opens a legacy SSE session on `GET /sse` and takes that session's messages on `POST /messages?sessionId=...`. mcp-proxy authenticates the first request only, so anyone who knew the session id could post tool calls without a token and they would run as the user who opened the stream. FastMCP has no option to turn the route off, so `authenticate` answers `GET /sse` with 404 before it looks at the token, and no legacy session can exist. Clients must use Streamable HTTP. If you serve the MCP route itself on `/sse`, `authenticate` refuses its `GET` requests too.
- **Protocol revisions.** The tests verify FastMCP with the revisions 2025-03-26, 2025-06-18 and 2025-11-25. FastMCP answers an initialize request for a newer revision with 2025-11-25.
- **Public routes.** FastMCP serves `/health`, `/ready` and the metadata routes without authentication. In stateless mode it answers `GET` and `DELETE` on the MCP route with 405 before `authenticate` runs.
- **Discovery and key outages.** When the tenant's discovery or key endpoints cannot be reached, the adapter answers the way the core client reports it, today with a 401 `invalid_token`.
- **FastMCP releases often.** The peer range is `^4.22.0`. FastMCP 4.22.0 is the first release that requires mcp-proxy 6.7.19, and mcp-proxy 6.7.17 is the first that calls `authenticate` for `GET` and `DELETE` on a live session. Older mcp-proxy releases, which FastMCP 4.21 and older accept, hand the event stream and the termination of a session to anyone who holds the session id without calling `authenticate`, so neither the token check nor the session binding applies to those requests.
- **Unwrapped tools.** The accessors of `@auth0/ai-mcp` only work inside `withAuth0Execute`. Resources and prompts get the session as FastMCP passes it.

## Feedback

Report problems and ask questions in the [auth0-ai-js issues](https://github.com/auth0/auth0-ai-js/issues).
