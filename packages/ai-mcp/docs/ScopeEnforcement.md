# Scope enforcement

Scope enforcement checks the scopes in the caller's incoming access token, which are the permissions Auth0 granted the caller for your MCP server. It is separate from the scopes of any downstream token that an [On Behalf Of exchange](./OnBehalfOf.md) produces.

There are two levels, and they fail differently on purpose.

| Level | Where | Failure |
| --- | --- | --- |
| Server-wide | `requiredScopes` option of the handler | HTTP 403 with `WWW-Authenticate: ... error="insufficient_scope"`. The request never reaches MCP. |
| Per tool | `withRequiredScopes` or `requireScopes` inside a tool | A tool result with `isError: true` and HTTP 200. Other tools keep working. |

Both compare against the `scope` claim only. The `permissions` claim is never consulted. Every listed scope must be present (AND semantics).

## Server-wide scopes

Scopes every request needs go in `requiredScopes`. The handler checks them after verification and before the request reaches MCP:

```ts
import { createMcpClient, createMcpHandler } from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
});

export const handle = createMcpHandler({
  client,
  resource: 'https://mcp.example.com/mcp',
  authorizationServers: ['https://your-tenant.us.auth0.com/'],
  requiredScopes: ['mcp:access'],
  handler: async () => Response.json({ ok: true }),
});
```

When a scope is missing the response is a 403 whose challenge lists only the missing scopes in its `scope` parameter, so a client learns what to request without learning what else the server knows about:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", error_description="The access token does not include the required scope.", scope="mcp:access", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
WWW-Authenticate: DPoP algs="ES256", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
```

The handler sends one challenge per scheme the DPoP mode accepts, and the error parameters go on the scheme the client used. With `dpop.mode` set to `'disabled'` only the Bearer line is sent.

## Per-tool scopes

`withRequiredScopes(required, handler)` wraps a tool callback. It reads the caller from the [request context](./RequestContext.md) and runs the callback only when the caller holds every required scope. Otherwise it returns a sanitized MCP error result instead of throwing:

```ts
import { withRequiredScopes } from '@auth0/ai-mcp';

export const getOrderSummary = withRequiredScopes(
  ['read:orders', 'read:payments'],
  async (orderId: string) => ({
    content: [{ type: 'text' as const, text: `Summary for ${orderId}` }],
  }),
);
```

Calling `getOrderSummary('42')` for a caller without `read:payments` resolves to:

```json
{
  "content": [{ "type": "text", "text": "Missing one or more required scopes." }],
  "isError": true,
  "_meta": { "error": "insufficient_scope" }
}
```

The text is generic and never names the scopes the server expects or the caller holds. Every other error, including errors thrown by your callback, propagates unchanged.

`required` accepts one scope, a space-delimited string of scopes, or an array. An empty requirement always passes.

## Imperative checks

`requireScopes(required, principal?)` throws instead of returning a result. It is useful for a secondary check partway through a tool, or when you want to turn the failure into your own response.

```ts
import { InsufficientScopeError, getCallerPrincipal, requireScopes } from '@auth0/ai-mcp';

export function canWriteOrders(): boolean {
  try {
    requireScopes('write:orders', getCallerPrincipal());
    return true;
  } catch (error) {
    if (error instanceof InsufficientScopeError) {
      return false;
    }
    throw error;
  }
}
```

It throws:

- `UnauthenticatedError` when you pass no principal and no request context is active. Passing `undefined` explicitly means "use the current caller".
- `InsufficientScopeError` when any scope is missing. The error's `requiredScopes` property holds the normalized list for server-side use. Do not echo it to clients.

When `InsufficientScopeError` escapes a custom `createMcpHandler` handler, the handler answers HTTP 403 with `insufficient_scope`. On `createMcpSdkHandler` and `createNodeMcpHandler`, the official MCP SDK's `McpServer` turns an error thrown inside a tool callback into a tool result with `isError: true` and a sanitized message, and the HTTP status stays 200. The same applies to `DownscopedTokenError` from a downscoped exchange inside a tool.

## Tenant-side setup

Auth0 puts a scope in a token only when you define the scope on the API (resource server) and the application's client grant lists it. Defining a scope on the API alone is not enough. If the client grant for the application that requests tokens for your MCP server does not include the scope, the check fails for every caller, even after a fresh login.

When you add a gated tool, define the scope on your MCP API and add it to the client grant. A client grant update replaces the whole scope list, so include the existing scopes as well.

```bash
auth0 api get "client-grants?audience=https://mcp.example.com/mcp"
auth0 api patch "client-grants/YOUR_GRANT_ID" \
  --data '{"scope":["mcp:access","tool:list_reports","tool:new_tool"]}'
```
