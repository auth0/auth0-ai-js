# Examples

Each recipe is a complete module. Replace the placeholder domain, audiences and scopes with your own.

- [A complete server with a token exchange](#a-complete-server-with-a-token-exchange)
- [Requiring a scope for one tool](#requiring-a-scope-for-one-tool)
- [Hiding a tool from callers without a scope](#hiding-a-tool-from-callers-without-a-scope)
- [Reusing exchanged tokens with a cache](#reusing-exchanged-tokens-with-a-cache)
- [Requiring DPoP](#requiring-dpop)
- [Calling a third-party API with Token Vault](#calling-a-third-party-api-with-token-vault)

## A complete server with a token exchange

A stateless server with two tools. `whoami` needs no scope beyond the server-wide ones. `list_orders` exchanges the caller's token for a token to a downstream API and never forwards the token the server received. If the exchange fails, the caller gets a generic tool error and the details stay on the server.

Set `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` in the environment. For a runnable version with tests, see [`examples/ai-fastmcp-server`](../../examples/ai-fastmcp-server).

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { getCallerMcpClientOrThrow } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const auth = createFastMcpAuth({ metadata: { scopesSupported: ["read:orders"] } });
const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });

server.addTool({
  name: "whoami",
  description: "Describes the signed-in caller.",
  parameters: z.object({}),
  execute: withAuth0Execute(async (_args, { session }) => {
    return `Signed in as ${session.principal.sub}`;
  }),
});

server.addTool({
  name: "list_orders",
  description: "Lists the caller's orders.",
  parameters: z.object({}),
  execute: withAuth0Execute(async () => {
    const { accessToken } = await getCallerMcpClientOrThrow().getTokenOnBehalfOf({
      audience: "https://api.example.com",
      scope: "read:orders",
    });
    const response = await fetch("https://api.example.com/orders", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return await response.text();
  }),
});

await server.start({
  transportType: "httpStream",
  httpStream: { endpoint: auth.endpoint, port: 3000, stateless: true },
});
```

## Requiring a scope for one tool

Pass `requiredScopes` to `withAuth0Execute` for a scope that only one tool needs. A caller without the scopes gets a tool result that names what is missing, and the tool stays in the tool list. List the scopes in `metadata.scopesSupported`: an OAuth client asks only for the scopes it finds in the metadata document or in the challenge, and a scope that only one tool checks is not published automatically. See [Tools](./docs/Tools.md#scopes-for-one-tool).

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const auth = createFastMcpAuth({ metadata: { scopesSupported: ["write:orders", "refund:orders"] } });
const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });

server.addTool({
  name: "refund_order",
  parameters: z.object({ id: z.string() }),
  execute: withAuth0Execute(async ({ id }) => `Refunded ${id}`, {
    requiredScopes: ["write:orders", "refund:orders"],
  }),
});

await server.start({
  transportType: "httpStream",
  httpStream: { endpoint: auth.endpoint, port: 3000, stateless: true },
});
```

## Hiding a tool from callers without a scope

Use FastMCP's `canAccess` with `requireScopes` when the existence of a tool is itself sensitive. The tool disappears from the list for callers without the scope, and the client cannot learn which scope it is missing. Choose `requiredScopes` instead when you want the client to see what it lacks. See [Tools](./docs/Tools.md#hiding-a-tool-instead).

```ts
import { FastMCP, requireScopes } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const auth = createFastMcpAuth();
const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });

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

await server.start({
  transportType: "httpStream",
  httpStream: { endpoint: auth.endpoint, port: 3000, stateless: true },
});
```

## Reusing exchanged tokens with a cache

Caching is off by default. Pass a `tokenStore` and a second exchange for the same caller, audience and scopes returns the stored token without a request to your tenant. The store is in memory, so two server instances do not share it. See [Token caching](./docs/TokenCaching.md).

```ts
import { MemoryIndexedTokenStore } from "@auth0/ai-mcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({
  domain: "your-tenant.us.auth0.com",
  audience: "https://mcp.example.com/mcp",
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  tokenStore: new MemoryIndexedTokenStore(),
});
```

To share one client, for example across several modules or in tests, build it with `createMcpClient` and pass it in:

```ts
import { MemoryIndexedTokenStore, createMcpClient } from "@auth0/ai-mcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

const client = createMcpClient({
  domain: "your-tenant.us.auth0.com",
  audience: "https://mcp.example.com/mcp",
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  tokenStore: new MemoryIndexedTokenStore(),
});

export const auth = createFastMcpAuth({ client });
```

## Requiring DPoP

The FastMCP adapter answers Bearer tokens only. Setting `dpop: { mode: "required" }` makes `createFastMcpAuth` throw `InvalidConfigurationError`. To require DPoP, use `@auth0/ai-mcp` with its Node adapter instead. See [DPoP](./docs/DPoP.md) for the mode table and [Requiring DPoP](../ai-mcp/EXAMPLES.md#requiring-dpop) in the `@auth0/ai-mcp` examples.

## Calling a third-party API with Token Vault

Token Vault works in a FastMCP tool as it does in `@auth0/ai-mcp`: inside a wrapped tool, `getCallerMcpClientOrThrow()` returns the caller's client, which exposes `getTokenForConnection`. See [Token Vault](../ai-mcp/docs/TokenVault.md) and [Calling a third-party API with Token Vault](../ai-mcp/EXAMPLES.md#calling-a-third-party-api-with-token-vault) in the `@auth0/ai-mcp` documentation.

## More

- [Getting started](./docs/GettingStarted.md)
- [Configuration](./docs/Configuration.md)
- [Tools](./docs/Tools.md)
- [Errors and status codes](./docs/Errors.md)
- [Troubleshooting](./docs/Troubleshooting.md)
- [Example server](../../examples/ai-fastmcp-server)
