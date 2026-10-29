# Tools

A FastMCP tool receives the verified caller as `context.session`. This guide covers what the session holds, how `withAuth0Execute` makes it available to the rest of your code, how to require a scope for one tool, and how to call a downstream API on behalf of the caller.

## The session

`authenticate` resolves to an `Auth0Session`, and FastMCP passes it to every tool as `context.session`:

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";
import type { Auth0Session } from "@auth0/ai-fastmcp";

const server = new FastMCP<Auth0Session>({ name: "orders", version: "1.0.0", ...createFastMcpAuth({}) });

server.addTool({
  name: "who_am_i",
  description: "Describes the caller.",
  parameters: z.object({}),
  execute: async (_args, { session }) => {
    const principal = session?.principal;
    return JSON.stringify({ sub: principal?.sub, clientId: principal?.clientId, orgId: principal?.orgId });
  },
});
```

| Field | Content |
| --- | --- |
| `principal` | The verified caller. `sub` is the subject, `scopes` the scopes of the `scope` claim, `clientId` the client that received the token (the `azp` claim, else `client_id`, else `null`), `orgId` the `org_id` claim or `null`, `permissions` the `permissions` claim or `null`, and `expiresAt` the expiry in epoch seconds. |
| `scopes` | The same scopes as a plain, frozen array. FastMCP's own `requireScopes` and `canAccess` work on it as they are. |
| `mcpClient` | A client bound to this caller. Use it to exchange the caller's token for a token to a downstream API. |

The session is frozen and holds no credential. The access token is not a property of the session, and serializing the session does not reveal it. The `scope` claim is the only source of `scopes`: `principal.permissions` carries the `permissions` claim, but no scope check uses it.

A request without a valid token never reaches a tool, because `authenticate` answers it first. FastMCP still types `session` as possibly `undefined`, so read it with `session?.` or let `withAuth0Execute` handle the case: when it finds no session, it returns the tool result `Authentication is required.` and does not run your function.

## withAuth0Execute

`withAuth0Execute(execute, options?)` wraps the `execute` function of a tool. Inside the wrapped function the accessors of `@auth0/ai-mcp` work: `getCallerPrincipal()`, `getCallerMcpClient()` and `getCallerMcpClientOrThrow()`. They let helper code deep in your application find the caller without receiving the session as an argument.

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { getCallerPrincipal } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const server = new FastMCP({ name: "orders", version: "1.0.0", ...createFastMcpAuth({}) });

async function auditLine(action: string): Promise<string> {
  return `${getCallerPrincipal()?.sub} ${action}`;
}

server.addTool({
  name: "cancel_order",
  parameters: z.object({ id: z.string() }),
  execute: withAuth0Execute(async ({ id }) => auditLine(`cancelled ${id}`)),
});
```

FastMCP has no outer layer where the adapter could bind the request context, so the binding happens in this wrapper. A tool you do not wrap still gets `context.session`, but the accessors return `undefined` (`getCallerMcpClientOrThrow()` throws `UnauthenticatedError`). Wrap every tool that uses them. Resources and prompts receive the session as the `auth` argument of their `load` function, and the accessors return `undefined` there too.

The wrapper keeps the argument types FastMCP infers from `parameters`. It also turns failures into safe tool results, see [Errors and status codes](./Errors.md#errors-inside-tools).

## Scopes for one tool

`requiredScopes` on `createFastMcpAuth` applies to every request. For a scope that only one tool needs, pass `requiredScopes` to `withAuth0Execute`. It takes one scope, a space-delimited string, or an array. The caller needs all of them.

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const server = new FastMCP({ name: "orders", version: "1.0.0", ...createFastMcpAuth({}) });

server.addTool({
  name: "refund_order",
  parameters: z.object({ id: z.string() }),
  execute: withAuth0Execute(async ({ id }) => `Refunded ${id}`, {
    requiredScopes: ["write:orders", "refund:orders"],
  }),
});
```

A caller who lacks a scope does not reach the function. The wrapper answers with an ordinary tool result:

- The text is `Missing required scope: refund:orders` for one missing scope, or `Missing required scopes: write:orders, refund:orders` for several. It names only the scopes the caller lacks.
- `isError` is `true` and `_meta.error` is `insufficient_scope`.
- The HTTP status is 200. The tool stays in the tool list, and the client can read what it is missing.

The check also covers a scope test inside the function: `requireScopes` from `@auth0/ai-mcp` throws when the principal lacks a scope, and the wrapper turns that into the same result.

### Hiding a tool instead

FastMCP has its own gate, `canAccess`. It removes a tool with `canAccess: requireScopes("admin:all")` from the tool list for callers without the scope, and a direct call to it fails with a JSON-RPC error whose message contains `Unknown tool`, provided the caller can see at least one other tool. The client cannot learn which scope it is missing.

```ts
import { FastMCP, requireScopes } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const server = new FastMCP({ name: "orders", version: "1.0.0", ...createFastMcpAuth({}) });

server.addTool({
  name: "list_orders",
  parameters: z.object({}),
  execute: withAuth0Execute(async () => "orders"),
});

server.addTool({
  name: "purge_cache",
  parameters: z.object({}),
  canAccess: requireScopes("admin:all"),
  execute: withAuth0Execute(async () => "purged"),
});
```

Choose `requiredScopes` when you want the client to see what is missing. Choose `canAccess` when the existence of the tool is itself sensitive.

## Calling downstream APIs for the caller

A tool that calls another API should send that API a token issued for it, with the caller as the subject, and never forward the access token it received. `session.mcpClient` exchanges the caller's token for such a token (RFC 8693, On Behalf Of):

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const server = new FastMCP({ name: "orders", version: "1.0.0", ...createFastMcpAuth({}) });

server.addTool({
  name: "invoices",
  parameters: z.object({ id: z.string() }),
  execute: withAuth0Execute(async ({ id }, { session }) => {
    const { accessToken } = await session!.mcpClient.getTokenOnBehalfOf({
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

The exchange needs `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` (or `clientId` and `clientSecret`) of an application with permission to exchange tokens for that audience. A server without them verifies tokens normally, but the exchange fails and the tool returns `Tool execution failed.`. The raw error reaches `onError`. Inside any wrapped function, `getCallerMcpClientOrThrow().getTokenOnBehalfOf(...)` does the same without the session argument.

The request-scoped client has four methods:

| Method | Use |
| --- | --- |
| `getPrincipal()` | The verified caller, the same value as `session.principal`. |
| `getTokenOnBehalfOf({ audience, scope? })` | A token for a downstream API with the caller as subject. |
| `getClientCredentialsToken({ audience, scope? })` | A token for the server itself, with no caller. |
| `getTokenForConnection({ connection })` | A token for a third-party service through Token Vault. |

The `@auth0/ai-mcp` guides explain each of them. Calls to `getTokenOnBehalfOf` can be cached, see [Token caching](./TokenCaching.md).

`@auth0/ai-mcp` sanitizes errors from these calls before your code sees them, and the wrapper maps whatever escapes to a fixed text. See [Errors and status codes](./Errors.md#errors-inside-tools).
