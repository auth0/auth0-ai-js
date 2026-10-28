# @auth0/ai-mcp

`@auth0/ai-mcp` secures [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers with Auth0. It is built on [`@auth0/auth0-api-js`](https://github.com/auth0/auth0-auth-js/tree/main/packages/auth0-api-js).

An MCP server is a resource server. This package ships no MCP framework of its own. It verifies the access token on every request, hands the verified caller to your tool code, and exchanges the caller's token for tokens to downstream APIs, with an optional cache in front of the exchange. A small adapter connects all of this to the official MCP TypeScript SDK.

[Documentation](#documentation) | [Getting started](#getting-started) | [Feedback](#feedback)

## How it works

1. **Verify.** Before your MCP handler runs, the request handler checks the `Authorization` header (Bearer or DPoP) against your Auth0 tenant. A missing or invalid token gets a 401 (a malformed `Authorization` header gets a 400) with a `WWW-Authenticate` challenge and never reaches a tool. The handler also serves the RFC 9728 protected resource metadata document.
2. **Gate.** The gate checks scopes that every request must carry and answers a missing one with HTTP 403 `insufficient_scope`. A tool checks the scopes that only it needs and answers a missing one with a tool result that has `isError: true`.
3. **Context.** On a valid token the handler builds a `Principal` from the verified claims and binds it, together with a request-scoped client, to the request through `AsyncLocalStorage`. Tool code reads the caller from there, so tool signatures stay clean.
4. **On Behalf Of.** A tool calls `getTokenOnBehalfOf({ audience, scope })` to exchange the caller's token for a token to a downstream API. A token store enables caching. See [Token caching](./docs/TokenCaching.md).
5. **Token Vault.** A tool calls `getTokenForService({ connection })` to get a federated provider token, such as a Google access token, through Auth0 Token Vault. See [Token Vault](./docs/TokenVault.md).
6. **Client credentials.** A tool calls `getClientCredentialsToken({ audience, scope })` to act as the server itself. See [On Behalf Of](./docs/OnBehalfOf.md#client-credentials).

## Getting started

### 1. Install

```bash
npm install @auth0/ai-mcp @modelcontextprotocol/sdk
```

`@auth0/auth0-api-js` is a regular dependency, so npm installs it with the package. Your application does not need to depend on it directly, because the token store types are re-exported from `@auth0/ai-mcp`.

`@modelcontextprotocol/sdk` (version 1.31 or later in the 1.x line) is an optional peer dependency. Only the `@auth0/ai-mcp/mcp-sdk` entry point imports it, so install it when you use that entry point. The main entry point `@auth0/ai-mcp` never loads it.

The package runs on Node.js and on runtimes that provide `node:async_hooks` with `AsyncLocalStorage`.

### 2. Create the client

```ts
import { createMcpClient } from '@auth0/ai-mcp';

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
});
```

`audience` is the identifier of your MCP server as an API in Auth0. Access tokens must be issued for it. Your tools need `clientId` and `clientSecret` only when they exchange tokens. A server that just verifies incoming tokens can omit them.

### 3. Serve MCP over HTTP

The `@auth0/ai-mcp/mcp-sdk` entry point connects the request handler to the official MCP SDK and to Node's `http` module:

```ts
import { createServer } from 'node:http';
import { createMcpClient, getCallerMcpClientOrThrow, withRequiredScopes } from '@auth0/ai-mcp';
import { createNodeMcpHandler } from '@auth0/ai-mcp/mcp-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
});

// Called once per request. Register tools here.
function buildServer(): McpServer {
  const server = new McpServer({ name: 'reports', version: '1.0.0' });

  server.registerTool(
    'list_reports',
    { description: 'Lists reports for the calling user.' },
    withRequiredScopes('tool:list_reports', async () => {
      const mcpClient = getCallerMcpClientOrThrow();
      const token = await mcpClient.getTokenOnBehalfOf({
        audience: 'https://reports-api.example.com',
        scope: 'read:reports',
      });
      const response = await fetch('https://reports-api.example.com/reports', {
        headers: { authorization: `Bearer ${token.accessToken}` },
      });
      return { content: [{ type: 'text' as const, text: await response.text() }] };
    }),
  );

  return server;
}

const handler = createNodeMcpHandler({
  client,
  requiredScopes: ['mcp:access'],
  createServer: buildServer,
});

createServer((req, res) => void handler(req, res)).listen(3000);
```

What this gives you:

- `POST /mcp` requires a valid access token with the `mcp:access` scope. Otherwise the client gets a 401 or 403 with a `WWW-Authenticate` challenge.
- `GET /.well-known/oauth-protected-resource/mcp` serves the protected resource metadata, so MCP clients can discover your authorization server. Some clients, such as Claude Code, also need tenant settings: see [MCP clients and tenant settings](./docs/McpClients.md).
- `list_reports` runs only for callers whose token carries `tool:list_reports`. Other callers get a tool result with `isError: true`.
- The token exchange always acts for the caller of the current request.

The handler needs no `resource` or `authorizationServers` here. `resource` defaults to the `audience` of the client (which must then be the public URL of your server) and `authorizationServers` defaults to `https://<domain>/`. See [when to set them yourself](./docs/Handler.md#when-to-set-resource-and-authorizationservers-yourself).

`createNodeMcpHandler` mounts on `http.createServer` as shown above. On Express, route both the MCP path and the protected resource metadata path to the handler, or MCP clients cannot discover your authorization server:

```text
app.all('/mcp', handler);
app.get('/.well-known/oauth-protected-resource/mcp', handler);
```

The metadata path is `/.well-known/oauth-protected-resource` followed by the path of `resource`. Set `metadata.path` to serve it elsewhere. Mount the handler before any body-parsing middleware. For other runtimes use `createMcpSdkHandler`, which takes a standard `Request` and returns a `Response`. For a different MCP stack use [`createMcpHandler`](./docs/Handler.md).

## Documentation

- [Handler and adapters](./docs/Handler.md): the framework-agnostic handler, the MCP SDK adapter and the Node adapter.
- [Token verification](./docs/TokenVerification.md): what the check covers, how the `Principal` is built, and DPoP support.
- [Request context](./docs/RequestContext.md): reading the caller inside a tool.
- [Scope enforcement](./docs/ScopeEnforcement.md): gate-level and tool-level scope checks.
- [On Behalf Of and client credentials](./docs/OnBehalfOf.md): downstream tokens for the caller and for the server.
- [Token caching](./docs/TokenCaching.md): token stores, scope matching modes and the encrypted store.
- [MCP clients and tenant settings](./docs/McpClients.md): what your Auth0 tenant must allow before a real MCP client such as Claude Code can sign in.
- [Token Vault](./docs/TokenVault.md): federated provider tokens.
- [Organization policy](./docs/OrganizationPolicy.md): accepting or requiring an organization.
- [Errors](./docs/Errors.md): every error class, with its HTTP status and code.
- [Known limitations](./docs/KnownLimitations.md)
- [Examples](./EXAMPLES.md): recipes for common setups.

## Feedback

### Contributing

Feedback and contributions are welcome. Before you start, read:

- [Auth0's general contribution guidelines](https://github.com/auth0/open-source-template/blob/master/GENERAL-CONTRIBUTING.md)
- [Auth0's code of conduct](https://github.com/auth0/open-source-template/blob/master/CODE-OF-CONDUCT.md)

### Raise an issue

To report a bug or request a feature, [raise an issue on the issue tracker](https://github.com/auth0/auth0-ai-js/issues).

## Vulnerability reporting

Do not report security vulnerabilities on the public GitHub issue tracker. The [Responsible Disclosure Program](https://auth0.com/responsible-disclosure-policy) explains how to report them.

## What is Auth0?

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.auth0.com/website/sdks/logos/auth0_dark_mode.png" width="150">
    <source media="(prefers-color-scheme: light)" srcset="https://cdn.auth0.com/website/sdks/logos/auth0_light_mode.png" width="150">
    <img alt="Auth0 Logo" src="https://cdn.auth0.com/website/sdks/logos/auth0_light_mode.png" width="150">
  </picture>
</p>
<p align="center">
  Auth0 is an easy to implement, adaptable authentication and authorization platform. To learn more, see <a href="https://auth0.com/why-auth0">Why Auth0?</a>
</p>
<p align="center">
  This project is licensed under the Apache 2.0 license. See the <a href="./LICENSE">LICENSE</a> file for more information.
</p>
