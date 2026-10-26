# Handler and adapters

The package is built in layers. `createMcpHandler` is the framework-agnostic core: it takes a standard Fetch API `Request` and returns a `Response`. The `@auth0/ai-mcp/mcp-sdk` entry point adds adapters for the official MCP TypeScript SDK and for Node's `http` module on top of it.

| Function | Entry point | Use it when |
| --- | --- | --- |
| `createMcpHandler` | `@auth0/ai-mcp` | You serve MCP with your own stack, or you want to manage the transport yourself. |
| `createMcpSdkHandler` | `@auth0/ai-mcp/mcp-sdk` | You use the official MCP SDK and your runtime speaks `Request` and `Response`. |
| `createNodeMcpHandler` | `@auth0/ai-mcp/mcp-sdk` | You use the official MCP SDK on Node's `http` module or Express. |
| `toNodeHandler` | `@auth0/ai-mcp/mcp-sdk` | You have a `Request` to `Response` function and want a Node request listener. |
| `asTokenVerifier` | `@auth0/ai-mcp/mcp-sdk` | You already use the SDK's `requireBearerAuth` middleware. See [limitations](./KnownLimitations.md). |

## The framework-agnostic handler

For every request `createMcpHandler` does the following, in order:

1. If the path is the metadata path, it serves the RFC 9728 protected resource metadata document and does nothing else.
2. It reads the credential from the `Authorization` header (and the `DPoP` header for DPoP-bound tokens).
3. It verifies the token with the `McpClient`. The client enforces the organization policy and DPoP rules you configured.
4. It checks `requiredScopes` against the `scope` claim.
5. It binds the caller to the request context and calls your `handler` with the original `Request` and an `AuthInfo` object.

```ts
import { createMcpClient, createMcpHandler, getCallerPrincipal } from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
});

export const handle = createMcpHandler({
  client,
  resource: 'https://mcp.example.com/mcp',
  authorizationServers: ['https://your-tenant.us.auth0.com/'],
  requiredScopes: ['mcp:access'],
  realm: 'mcp',
  metadata: {
    scopesSupported: ['mcp:access', 'tool:list_reports'],
    resourceName: 'Reports MCP server',
  },
  onError: (error) => {
    // Called for every 500. The error never reaches the response.
    console.error('mcp request failed', error instanceof Error ? error.name : 'unknown');
  },
  handler: async (request, authInfo) => {
    const principal = getCallerPrincipal();
    return Response.json({
      method: request.method,
      sub: authInfo.extra?.sub,
      scopes: authInfo.scopes,
      sameCaller: principal?.sub === authInfo.extra?.sub,
    });
  },
});
```

`handle` is a plain function, so it plugs into anything that speaks the Fetch API, for example `export default { fetch: handle }` on a Workers-style runtime.

### Options

| Option | Description |
| --- | --- |
| `client` | The `McpClient` from `createMcpClient`. Verifies tokens and creates the request-scoped client. |
| `resource` | Absolute URL that identifies this server. It is the `resource` of the metadata document. |
| `authorizationServers` | Issuer URLs of the authorization servers that issue tokens for this server. |
| `handler` | Serves the authenticated request. It runs inside the request context. |
| `requiredScopes` | Scopes every request must carry. The token needs all of them. |
| `realm` | Protection space reported as `realm` in challenges. Must be a non-empty string without quotes, backslashes or control characters. |
| `metadata.path` | Custom path of the metadata route. It must be an absolute, normalized path without query or fragment. |
| `metadata.scopesSupported`, `metadata.resourceName`, `metadata.resourceDocumentation` | Extra fields published in the metadata document. |
| `onError` | Observer for internal errors. The handler ignores a hook that throws. |

`createMcpHandler` throws `InvalidConfigurationError` for an invalid `metadata.path` or `realm`, and a `TypeError` when `resource` is not an absolute URL.

### What the handler answers

Failures that happen before your handler runs use a generic JSON body (`error` and `error_description`) and a rebuilt `WWW-Authenticate` challenge. Messages from the verifier are never echoed.

| Situation | Status | `error` in the challenge |
| --- | --- | --- |
| No credential, or a scheme the configured DPoP mode does not accept | 401 | none |
| Malformed `Authorization` or `DPoP` header | 400 | `invalid_request` |
| Token fails verification, including organization policy failures | 401 | `invalid_token` |
| DPoP proof fails verification | 401 | `invalid_dpop_proof` |
| Server requires a DPoP nonce | 401 | `use_dpop_nonce` |
| Token lacks a scope in `requiredScopes` | 403 | `insufficient_scope`, with `scope` listing the missing scopes |
| Your handler throws `UnauthenticatedError` | 401 | `invalid_token` |
| A custom `createMcpHandler` handler throws `InsufficientScopeError` or `DownscopedTokenError` | 403 | `insufficient_scope` |
| Anything else | 500 | no challenge, generic body |

A missing credential gets a challenge without an `error` value, because RFC 6750 section 3.1 reserves error values for requests that did carry authentication. The challenge always advertises the schemes the DPoP mode accepts and the `resource_metadata` URL.

Every path other than the metadata path goes through authentication. The handler does not route, so mount it only on the path that serves MCP, and also on the metadata path. The metadata path is `/.well-known/oauth-protected-resource` followed by the path of `resource` (for `https://mcp.example.com/mcp` that is `/.well-known/oauth-protected-resource/mcp`), unless you set `metadata.path`. A framework that routes by path, such as Express, needs both routes or discovery fails:

```text
app.all('/mcp', handler);
app.get('/.well-known/oauth-protected-resource/mcp', handler);
```

### Proxies

DPoP proofs are bound to the request URL, and the handler checks them against `request.url`. Behind a proxy that rewrites the URL, pass the handler a `Request` whose URL is the public one the client used. The handler has no option to override it.

## The MCP SDK adapter

`createMcpSdkHandler` wraps `createMcpHandler` and serves each authenticated request with the SDK's web standard Streamable HTTP transport.

```ts
import { createMcpClient, getCallerPrincipal } from '@auth0/ai-mcp';
import { createMcpSdkHandler } from '@auth0/ai-mcp/mcp-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
});

export const handle = createMcpSdkHandler({
  client,
  resource: 'https://mcp.example.com/mcp',
  authorizationServers: ['https://your-tenant.us.auth0.com/'],
  requiredScopes: ['mcp:access'],
  createServer: () => {
    const server = new McpServer({ name: 'reports', version: '1.0.0' });
    server.registerTool(
      'whoami',
      { description: 'Returns the subject of the caller.' },
      async (extra) => ({
        content: [
          {
            type: 'text' as const,
            text: `${getCallerPrincipal()?.sub} / ${extra.authInfo?.clientId}`,
          },
        ],
      }),
    );
    return server;
  },
});
```

The verified caller reaches your tools in two ways: as `extra.authInfo` in every tool callback, which is the SDK's own mechanism, and through the request context, so `getCallerMcpClient()`, `getCallerPrincipal()` and `withRequiredScopes()` work inside tools. `authInfo.clientId` is an empty string when the token carries neither `client_id` nor `azp`.

The verified caller reaches your tools in the ways above, but the raw access token does not: `extra.authInfo.token` is intentionally an empty string. Call downstream APIs through the request-scoped client (`getCallerMcpClient()`), never with a token you read yourself. The MCP SDK still exposes the raw request headers, including `Authorization`, to tools through `extra.requestInfo.headers`, so tool code must not log or forward headers.

A downscoped token exchange inside a tool is not an HTTP failure on this adapter. The SDK turns the error into a tool result with `isError: true` and a generic message, and the response stays HTTP 200. The 403 `insufficient_scope` response applies only when the error escapes a custom `createMcpHandler` handler, as in the table above. A request to the MCP endpoint with any method other than `POST` gets a 405 with `Allow: POST`.

`createServer` runs once per request, and the adapter closes the server when the request ends. Register tools inside it and keep expensive setup outside of it.

The adapter is stateless and answers with JSON bodies. See [known limitations](./KnownLimitations.md#the-mcp-sdk-adapter-is-stateless).

## Node adapter

`createNodeMcpHandler` combines `createMcpSdkHandler` with `toNodeHandler`. Use `toNodeHandler` directly to put any `Request` to `Response` function behind Node's `http`:

```ts
import { createServer } from 'node:http';
import { createMcpClient, createMcpHandler } from '@auth0/ai-mcp';
import { toNodeHandler } from '@auth0/ai-mcp/mcp-sdk';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
});

const web = createMcpHandler({
  client,
  resource: 'https://mcp.example.com/mcp',
  authorizationServers: ['https://your-tenant.us.auth0.com/'],
  handler: async () => Response.json({ ok: true }),
});

const listener = toNodeHandler(web, {
  resource: 'https://mcp.example.com/mcp',
  maxBodyBytes: 256 * 1024,
});

createServer((req, res) => void listener(req, res)).listen(3000);
```

`toNodeHandler` only converts messages. All authentication stays in the web handler.

- It rebuilds the absolute request URL from the origin of `resource`, so the `Host` header of the incoming request is never trusted.
- Headers, including `Authorization` and `DPoP`, pass through unchanged.
- The body is read up to `maxBodyBytes` (1 MiB by default). A larger body gets a 413 and the adapter closes the connection. A malformed `Content-Length`, or a path that does not start with a single `/`, gets a 400.
- Mount it before body-parsing middleware. If a parser already consumed the stream, the adapter serializes the parsed `req.body` again with the same size limit, so the bytes the handler sees can differ from the original.
- The returned function never rejects. Any other error becomes a generic 500.
