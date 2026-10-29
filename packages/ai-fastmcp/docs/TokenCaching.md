# Token caching

Each call to `getTokenOnBehalfOf` is a request to your Auth0 tenant. Caching is optional and off by default: without a `tokenStore`, every call performs a new exchange and nothing is kept.

This adapter uses the token store of `@auth0/ai-mcp`. The guide [Token caching](../../ai-mcp/docs/TokenCaching.md) of that package describes the store interface, the scope matching modes and the cache keys in full. This page shows how to turn the cache on in a FastMCP server and what you can rely on.

## Turn it on

Pass a `tokenStore` with the inline options:

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

Or give it to the client you pass in:

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

Nothing else changes in your tools. A second `getTokenOnBehalfOf` for the same audience and scopes by the same caller returns the stored token, and no request goes to the tenant.

## What is cached

- **On Behalf Of results** go into the store. Client credentials tokens do not: `getClientCredentialsToken` asks the tenant every time.
- **Per caller.** The key includes the subject, so the store never hands one caller a token issued for another. It also includes the audience, the scopes, the client that performs the exchange, and the session of the incoming token. The session is the `sid` claim, or the `jti` claim when there is no `sid`, or the token itself when there is neither. In practice a token is reused for requests that present the same access token or tokens that share a `sid`. Two different tokens without a `sid` do not share entries.
- **By granted scopes.** The scope comparison uses the scopes the tenant granted, not the ones the tool requested.

## Scope matching

`scopeMatching` decides when a stored token counts as a hit:

| Mode | The store returns a stored token when |
| --- | --- |
| `"strict"` (default) | Its granted scopes are exactly the requested scopes. |
| `"non_strict"` | Its granted scopes cover the requested scopes. The smallest such token wins. |

`"non_strict"` needs a store that supports an index. `MemoryIndexedTokenStore` does. Passing `scopeMatching: "non_strict"` with a store that lacks one throws `InvalidConfigurationError` when you create the adapter.

```ts
import { MemoryIndexedTokenStore } from "@auth0/ai-mcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({
  tokenStore: new MemoryIndexedTokenStore(),
  scopeMatching: "non_strict",
});
```

With `"non_strict"`, a call for `api:read` reuses a token the tenant issued for `api:read api:write`. With `"strict"` it exchanges again.

## The reference store

`MemoryIndexedTokenStore` is the store to start with and the reference for your own. It keeps entries in the memory of the process, bounds their number (`maxEntries`, with the least recently used entry evicted first) and drops expired entries lazily. Because it lives in one process, two server instances do not share it, and a restart empties it. A cache miss only costs an exchange, so that is safe, but it means a fleet of instances exchanges more often than one process does.

## Several instances

For instances that must share exchanged tokens, implement `TokenStore` (and `IndexedTokenStore` for `"non_strict"`) on shared storage such as Redis, and wrap it with `createEncryptedTokenStore`:

```ts
import { MemoryIndexedTokenStore, createEncryptedTokenStore } from "@auth0/ai-mcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

const secret = process.env.TOKEN_STORE_SECRET;
if (secret === undefined) throw new Error("TOKEN_STORE_SECRET is not set.");

export const auth = createFastMcpAuth({
  // Replace MemoryIndexedTokenStore with your shared store.
  tokenStore: createEncryptedTokenStore(new MemoryIndexedTokenStore(), { secret }),
  scopeMatching: "non_strict",
});
```

The wrapper encrypts every value before it reaches the inner store, so the shared storage never holds an access token in the clear. The secret must be at least 32 characters, and every instance that shares the storage must use the same one. The [store guide of `@auth0/ai-mcp`](../../ai-mcp/docs/TokenCaching.md#encrypted-store) covers the format, the secret rules and the limits.

A stored token is a credential for your downstream API until it expires. Treat the store like any place that holds credentials.

## Session binding is a different map

The cache and the session binding of stateful servers are separate. The binding remembers which subject owns a `mcp-session-id`. It never holds a token. See [Stateless and stateful servers](./StatelessAndStateful.md).
