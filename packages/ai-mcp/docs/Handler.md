# Handler and adapters

The package is built in layers. `createMcpHandler` is the framework-agnostic core: it takes a standard Fetch API `Request` and returns a `Response`. The `@auth0/ai-mcp/mcp-sdk` entry point adds adapters for the official MCP TypeScript SDK and for Node's `http` module on top of it.

| Function | Entry point | Use it when |
| --- | --- | --- |
| `createMcpHandler` | `@auth0/ai-mcp` | You serve MCP with your own stack, or you want to manage the transport yourself. |
| `createMcpSdkHandler` | `@auth0/ai-mcp/mcp-sdk` | You use the official MCP SDK and your runtime speaks `Request` and `Response`. |
| `createNodeMcpHandler` | `@auth0/ai-mcp/mcp-sdk` | You use the official MCP SDK on Node's `http` module or Express. |
| `toNodeHandler` | `@auth0/ai-mcp/mcp-sdk` | You have a `Request` to `Response` function and want a Node request listener. |
| `authenticateRequest` | `@auth0/ai-mcp` | You write your own adapter and want the authentication step alone. See [Writing your own adapter](#writing-your-own-adapter). |
| `asTokenVerifier` | `@auth0/ai-mcp/mcp-sdk` | You already use the SDK's `requireBearerAuth` middleware. See [limitations](./KnownLimitations.md). |

## The framework-agnostic handler

For every request `createMcpHandler` does the following, in order:

1. If the path is one of the two metadata paths, it serves the RFC 9728 protected resource metadata document and does nothing else.
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
| `client` | The `McpClient` from `createMcpClient`. Verifies tokens and creates the request-scoped client. Optional: leave it out and pass client options inline (`domain`, `audience`, `clientId`, `clientSecret`, `tokenStore` and the rest), or pass nothing and the handler reads `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`. Combining `client` with an inline option throws. See [Configuration](../README.md#configuration). |
| `resource` | Absolute URL that identifies this server. It is the `resource` of the metadata document. Optional: defaults to the `audience` of the client when that is an absolute `http` or `https` URL. If you set it, it must equal the audience. See [resource and audience](#resource-and-audience). |
| `authorizationServers` | Issuer URLs of the authorization servers that issue tokens for this server. Optional: defaults to `https://<domain>/`, built from the `domain` of the client. |
| `handler` | Serves the authenticated request. It runs inside the request context. |
| `requiredScopes` | Scopes every request must carry. The token needs all of them. |
| `realm` | Protection space reported as `realm` in challenges. Must be a non-empty string without quotes, backslashes or control characters. |
| `metadata.path` | Replaces the suffixed metadata route. It must be an absolute, normalized path without query or fragment. The root route `/.well-known/oauth-protected-resource` is served regardless. |
| `metadata.scopesSupported`, `metadata.resourceName`, `metadata.resourceDocumentation` | Extra fields published in the metadata document. |
| `onError` | Observer for internal errors. The handler ignores a hook that throws. |

`createMcpHandler` throws `InvalidConfigurationError` for an invalid `metadata.path` or `realm`, for `client` combined with inline client options, and for an explicit `resource` that differs from the audience. It throws a `TypeError` when an explicit `resource` is not an absolute URL. It also throws `InvalidConfigurationError`, naming the option, when you omit `resource` or `authorizationServers` and the client cannot supply a usable default (see below). All of this happens when you create the handler, not on the first request.

### Resource and audience

`resource` is the URL clients use to reach your MCP server, and clients send it back as the RFC 8707 `resource` parameter. `audience` is the Auth0 API identifier that must appear as `aud` in access tokens. The handler only accepts tokens for the audience, so advertising any other resource would send clients to a server that refuses their tokens. For that reason the two must be the same string, and the handler enforces it:

- Leave `resource` out and it defaults to the audience. This is the recommended setup, and it needs an audience that is an absolute `http` or `https` URL without a fragment or credentials.
- If you set `resource`, it must equal the audience. The comparison is an exact string match after lower-casing the scheme and the host only. The path, the query and a trailing slash are significant, so `https://mcp.example.com/mcp/` is not `https://mcp.example.com/mcp`.
- A mismatch throws `InvalidConfigurationError` when you create the handler. The message contains neither value. When the only difference is a trailing slash it adds `The two differ only by a trailing slash, which counts as a difference.`

Two setups that older versions allowed no longer work. A public URL that differs from the audience (behind a reverse proxy or a gateway) is a mismatch, so make the audience the public URL. A non-URL audience such as `my-mcp-server` or `urn:acme:mcp` cannot be served by the handler at all: without `resource` it throws that `resource` is required, and an explicit URL `resource` is a mismatch. Name your Auth0 API with the public URL of the server.

`authorizationServers` still has its own rules. Set it yourself when:

- You advertise more than one authorization server, or an issuer that is not `https://<domain>/`. Each entry must match the `iss` value clients see. The default uses the tenant domain with the scheme `https` and a trailing slash, which is the issuer of an Auth0 tenant or custom domain.
- The client does not declare a single `domain`, for example when you pass an `apiClient` that verifies tokens against a list or a resolver of domains. Without `authorizationServers` the handler throws `InvalidConfigurationError`.

```ts
import { createMcpClient, createMcpHandler } from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
});

export const handle = createMcpHandler({
  client,
  authorizationServers: ['https://your-tenant.us.auth0.com/', 'https://login.example.com/'],
  handler: async () => Response.json({ ok: true }),
});
```

When you pass your own `apiClient` to `createMcpClient`, the `domain` and `audience` you declare next to it feed the defaults and the audience check. Keep them equal to the values of that client.

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

Every path other than the metadata paths goes through authentication. The handler does not route, so mount it only on the path that serves MCP, and also on the metadata paths. It answers `GET` on two of them with the same document, and `405` with an `Allow: GET` header for any other method:

- The RFC 9728 suffixed path, which is `/.well-known/oauth-protected-resource` followed by the path of `resource`. For `https://mcp.example.com/mcp` that is `/.well-known/oauth-protected-resource/mcp`. `metadata.path` replaces this route.
- The root path `/.well-known/oauth-protected-resource`, which some MCP clients request first. It is served whatever `metadata.path` says. For a resource without a path, the two are the same route.

The `resource_metadata` URL in a challenge names the suffixed route (or the custom `metadata.path`). A framework that routes by path, such as Express, needs all of them or discovery fails:

```text
app.all('/mcp', handler);
app.get('/.well-known/oauth-protected-resource/mcp', handler);
app.get('/.well-known/oauth-protected-resource', handler);
```

### Proxies

DPoP proofs are bound to the request URL, and the handler checks them against `request.url`. Behind a proxy that rewrites the URL, pass the handler a `Request` whose URL is the public one the client used. The handler has no option to override it.

## The MCP SDK adapter

`createMcpSdkHandler` wraps `createMcpHandler` and serves each authenticated request with the SDK's web standard Streamable HTTP transport from `@modelcontextprotocol/server` (MCP TypeScript SDK v2, version 2.3 or later). It creates a new stateless transport for every request and answers with a JSON body. Tool input schemas are zod 4.2 or later objects, for example `z.object({ id: z.string() })`.

```ts
import { createMcpClient, getCallerPrincipal } from '@auth0/ai-mcp';
import { createMcpSdkHandler } from '@auth0/ai-mcp/mcp-sdk';
import { McpServer } from '@modelcontextprotocol/server';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
});

export const handle = createMcpSdkHandler({
  client,
  requiredScopes: ['mcp:access'],
  createServer: () => {
    const server = new McpServer({ name: 'reports', version: '1.0.0' });
    server.registerTool(
      'whoami',
      { description: 'Returns the subject of the caller.' },
      async (ctx) => ({
        content: [
          {
            type: 'text' as const,
            text: `${getCallerPrincipal()?.sub} / ${ctx.http?.authInfo?.clientId}`,
          },
        ],
      }),
    );
    return server;
  },
});
```

The verified caller reaches your tools in two ways: as `ctx.http?.authInfo` in every tool callback, which is the SDK's own mechanism, and through the request context, so `getCallerMcpClient()`, `getCallerPrincipal()` and `withRequiredScopes()` work inside tools. `authInfo.clientId` is the `azp` claim, or the `client_id` claim when there is no `azp`, and an empty string when the token carries neither.

The verified caller reaches your tools in the ways above, but the raw access token does not: `ctx.http?.authInfo?.token` is intentionally an empty string. Call downstream APIs through the request-scoped client (`getCallerMcpClient()`), never with a token you read yourself. The MCP SDK still exposes the raw request headers, including `Authorization`, to tools through `ctx.http?.req.headers`, a standard `Request`, so tool code must not log or forward headers.

A downscoped token exchange inside a tool is not an HTTP failure on this adapter. The SDK turns the error into a tool result with `isError: true` and the error's message (generic for this error), and the response stays HTTP 200. The 403 `insufficient_scope` response applies only when the error escapes a custom `createMcpHandler` handler, as in the table above. A request to the MCP endpoint with any method other than `POST` gets a 405 with `Allow: POST`.

`createServer` runs once per request, and the adapter closes the server when the request ends. Register tools inside it and keep expensive setup outside of it.

The adapter is stateless and answers with JSON bodies. See [known limitations](./KnownLimitations.md#the-mcp-sdk-adapter-is-stateless).

## Using the MCP SDK v1

`@auth0/ai-mcp/mcp-sdk` supports the MCP SDK v2 only. Objects from `@modelcontextprotocol/sdk` (v1) and `@modelcontextprotocol/server` (v2) must not be mixed, so the adapters do not accept a v1 server. If you stay on v1, build the transport glue yourself on top of the framework-neutral `createMcpHandler`. This recipe is unsupported by the package and pinned to the v1.x line of the SDK. It sends a fresh stateless transport and server per request, the way the v2 adapter does:

```text
import { createMcpClient, createMcpHandler } from '@auth0/ai-mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

const client = createMcpClient({ domain: 'your-tenant.us.auth0.com', audience: 'https://mcp.example.com/mcp' });

export const handle = createMcpHandler({
  client,
  requiredScopes: ['mcp:access'],
  handler: async (request) => {
    const server = new McpServer({ name: 'reports', version: '1.0.0' }); // register tools here
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  },
});
```

The handler authenticates the request and binds the request context, so `getCallerMcpClient()`, `getCallerPrincipal()` and `withRequiredScopes()` work in v1 tools as well. The recipe does not return a 405 for methods other than `POST` and does not fill `authInfo` in tool callbacks. Add those yourself if you need them.

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
  handler: async () => Response.json({ ok: true }),
});

const listener = toNodeHandler(web, {
  resource: 'https://mcp.example.com/mcp',
  maxBodyBytes: 256 * 1024,
});

createServer((req, res) => void listener(req, res)).listen(3000);
```

`toNodeHandler` only converts messages. All authentication stays in the web handler. It has no client to take defaults from, so its `resource` is required. `createNodeMcpHandler` applies the same defaults and the same three configuration tiers as `createMcpHandler` (it builds the client once and shares it with the endpoint defaults) and uses the resulting `resource` for the origin.

- It rebuilds the absolute request URL from the origin of `resource`, so the `Host` header of the incoming request is never trusted.
- Headers, including `Authorization` and `DPoP`, pass through unchanged.
- The body is read up to `maxBodyBytes` (1 MiB by default). A larger body gets a 413 and the adapter closes the connection. A malformed `Content-Length`, or a path that does not start with a single `/`, gets a 400.
- Mount it before body-parsing middleware. If a parser already consumed the stream, the adapter serializes the parsed `req.body` again with the same size limit, so the bytes the handler sees can differ from the original.
- The returned function never rejects. Any other error becomes a generic 500.

## Writing your own adapter

`createMcpHandler` is built from public parts, so a stack it does not cover (a framework with its own routing, a different MCP library, a worker runtime with special body handling) can reuse the same authentication. The pieces are:

| Export | What it does |
| --- | --- |
| `authenticateRequest(request, options)` | Reads the credential, verifies it, enforces `requiredScopes` and creates the request-scoped client. Resolves to `{ ok: false, response }` or `{ ok: true, authInfo, caller, scheme, run }`. |
| `buildProtectedResourceMetadata(options)` | Builds the RFC 9728 document as a plain object. |
| `buildWwwAuthenticate(options)` | Builds the `WWW-Authenticate` challenge lines for a response of your own. |

`authenticateRequest` takes `{ client, resource?, requiredScopes?, realm?, resourceMetadataUrl?, onError? }`. It needs a built `client`, because creating a client per request would repeat the key and discovery fetches. Build the client once, with `createMcpClient(resolveMcpClientOptions(...))` if you want the environment. Bad requests never throw: they come back as `{ ok: false, response }` with the right status, a generic body and a challenge, ready to return as is. Only invalid configuration rejects the promise (a `resource` that differs from the audience, an unusable `realm`), and the same resource rule applies as for the handler.

On success, `authInfo` is what the handler passes to its own `handler`, `caller` is the `RequestContext`, and `scheme` is the scheme the request authenticated with. Call `run(fn)` to execute your code inside the request context, so `getCallerMcpClient()`, `getCallerPrincipal()` and `withRequiredScopes()` work in everything `fn` starts. An error thrown inside `fn` propagates unchanged: mapping it to a response is up to you, which is how you keep control over what the client sees. Pass a `Request` whose URL is the public one, because DPoP proofs are checked against `request.url`.

This adapter serves the metadata document, authenticates, and turns a missing tool scope into a 403 challenge that names only that scope:

```ts
import {
  InsufficientScopeError,
  authenticateRequest,
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  createMcpClient,
  getCallerPrincipal,
  requireScopes,
} from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
});

const METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const metadata = buildProtectedResourceMetadata({ client, scopesSupported: ['mcp:access', 'tool:admin'] });

export async function handle(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return Response.json(metadata);
  }

  const result = await authenticateRequest(request, {
    client,
    requiredScopes: ['mcp:access'],
    resourceMetadataUrl: METADATA_URL,
    onError: (error) => console.error('mcp error', error instanceof Error ? error.name : 'unknown'),
  });
  if (!result.ok) {
    return result.response;
  }

  try {
    return await result.run(async () => {
      requireScopes('tool:admin');
      return Response.json({ sub: getCallerPrincipal()?.sub });
    });
  } catch (error) {
    if (error instanceof InsufficientScopeError) {
      const headers = new Headers({ 'content-type': 'application/json' });
      const challenges = buildWwwAuthenticate({
        schemes: [result.scheme],
        error: 'insufficient_scope',
        errorDescription: 'The access token does not include the required scope.',
        scope: ['tool:admin'],
        resourceMetadata: METADATA_URL,
      });
      for (const challenge of challenges) {
        headers.append('www-authenticate', challenge);
      }
      return new Response(JSON.stringify({ error: 'insufficient_scope' }), { status: 403, headers });
    }
    throw error;
  }
}
```

`buildWwwAuthenticate` strips characters that could break out of a quoted value and returns one line per scheme, with the error parameters on `errorScheme` (the first scheme by default). Pass every scheme your client accepts if you want the response to advertise them all. The MCP SDK adapter answers `405` for methods other than `POST` and the Node adapter limits the body size. An adapter of your own has to do those itself.
