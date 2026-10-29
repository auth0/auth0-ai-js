# @auth0/ai-mcp

`@auth0/ai-mcp` secures [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers with Auth0. It is built on [`@auth0/auth0-api-js`](https://github.com/auth0/auth0-auth-js/tree/main/packages/auth0-api-js).

An MCP server is a resource server. This package ships no MCP framework of its own. It verifies the access token on every request, hands the verified caller to your tool code, and exchanges the caller's token for tokens to downstream APIs, with an optional cache in front of the exchange. A small adapter connects all of this to the official MCP TypeScript SDK.

[Quickstart](#quickstart) | [Documentation](#documentation) | [Getting started](#getting-started) | [Feedback](#feedback)

## Quickstart

Set the connection details in the environment, then pass nothing but your tools:

```bash
export AUTH0_DOMAIN=your-tenant.us.auth0.com
export AUTH0_AUDIENCE=https://mcp.example.com/mcp
export AUTH0_CLIENT_ID=your-client-id
export AUTH0_CLIENT_SECRET=your-client-secret
```

```ts
import { createServer } from 'node:http';
import { getCallerPrincipal } from '@auth0/ai-mcp';
import { createNodeMcpHandler } from '@auth0/ai-mcp/mcp-sdk';
import { McpServer } from '@modelcontextprotocol/server';

const handler = createNodeMcpHandler({
  createServer: () => {
    const server = new McpServer({ name: 'hello', version: '1.0.0' });
    server.registerTool('hello', { description: 'Greets the caller.' }, async () => ({
      content: [{ type: 'text' as const, text: `Hello ${getCallerPrincipal()?.sub}` }],
    }));
    return server;
  },
});

createServer((req, res) => void handler(req, res)).listen(3000);
```

This serves `POST /mcp`, requires a valid Auth0 access token for the audience, and publishes the protected resource metadata. `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` are needed only when a tool exchanges tokens.

To keep the settings in code, pass them as options instead. Anything you leave out is still read from the environment:

```ts
import { createServer } from 'node:http';
import { createNodeMcpHandler } from '@auth0/ai-mcp/mcp-sdk';
import { McpServer } from '@modelcontextprotocol/server';

const handler = createNodeMcpHandler({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.MY_CLIENT_ID,
  clientSecret: process.env.MY_CLIENT_SECRET,
  createServer: () => new McpServer({ name: 'hello', version: '1.0.0' }),
});

createServer((req, res) => void handler(req, res)).listen(3000);
```

The rest of this page explains the pieces.

## How it works

1. **Verify.** Before your MCP handler runs, the request handler checks the `Authorization` header (Bearer or DPoP) against your Auth0 tenant. A missing or invalid token gets a 401 (a malformed `Authorization` header gets a 400) with a `WWW-Authenticate` challenge and never reaches a tool. The handler also serves the RFC 9728 protected resource metadata document.
2. **Gate.** The gate checks scopes that every request must carry and answers a missing one with HTTP 403 `insufficient_scope`. A tool checks the scopes that only it needs and answers a missing one with a tool result that has `isError: true`.
3. **Context.** On a valid token the handler builds a `Principal` from the verified claims and binds it, together with a request-scoped client, to the request through `AsyncLocalStorage`. Tool code reads the caller from there, so tool signatures stay clean.
4. **On Behalf Of.** A tool calls `getTokenOnBehalfOf({ audience, scope })` to exchange the caller's token for a token to a downstream API. A token store enables caching. See [Token caching](./docs/TokenCaching.md).
5. **Token Vault.** A tool calls `getTokenForConnection({ connection })` to get a federated provider token, such as a Google access token, through Auth0 Token Vault. See [Token Vault](./docs/TokenVault.md).
6. **Client credentials.** A tool calls `getClientCredentialsToken({ audience, scope })` to act as the server itself. See [On Behalf Of](./docs/OnBehalfOf.md#client-credentials).

## Getting started

### 1. Install

```bash
npm install @auth0/ai-mcp @modelcontextprotocol/server
```

`@auth0/auth0-api-js` is a regular dependency, so npm installs it with the package. Your application does not need to depend on it directly, because the token store types and the `AuthError` and `InvalidConfigurationError` classes are re-exported from `@auth0/ai-mcp`. Import the two classes from `@auth0/ai-mcp` for `instanceof` checks, so they match the classes the package throws even when your application resolves more than one copy of the core package.

`@modelcontextprotocol/server` (version 2.3 or later, from the MCP TypeScript SDK v2) is an optional peer dependency. Only the `@auth0/ai-mcp/mcp-sdk` entry point imports it, so install it when you use that entry point. The main entry point `@auth0/ai-mcp` never loads it.

The MCP SDK v2 requires Node.js 20 or later, and tool input schemas use zod 4.2 or later. The package runs on Node.js and on runtimes that provide `node:async_hooks` with `AsyncLocalStorage`.

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

`createMcpClient` reads nothing from the environment. See [Configuration](#configuration) for the environment helper and the handler shortcuts.

### 3. Serve MCP over HTTP

The `@auth0/ai-mcp/mcp-sdk` entry point connects the request handler to the official MCP SDK and to Node's `http` module:

```ts
import { createServer } from 'node:http';
import { createMcpClient, getCallerMcpClientOrThrow, withRequiredScopes } from '@auth0/ai-mcp';
import { createNodeMcpHandler } from '@auth0/ai-mcp/mcp-sdk';
import { McpServer } from '@modelcontextprotocol/server';

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
- `GET /.well-known/oauth-protected-resource/mcp` serves the protected resource metadata, so MCP clients can discover your authorization server. The same document is also served at `/.well-known/oauth-protected-resource`. Some clients, such as Claude Code, also need tenant settings: see [MCP clients and tenant settings](./docs/McpClients.md).
- `list_reports` runs only for callers whose token carries `tool:list_reports`. Other callers get a tool result with `isError: true`.
- The token exchange always acts for the caller of the current request.

The handler needs no `resource` or `authorizationServers` here. `resource` defaults to the `audience` of the client, which must therefore be the public URL of your server, and `authorizationServers` defaults to `https://<domain>/`. If you set `resource` yourself it must equal the audience. See [resource and audience](./docs/Handler.md#resource-and-audience).

`createNodeMcpHandler` mounts on `http.createServer` as shown above. On Express, route the MCP path and both protected resource metadata paths to the handler, or MCP clients cannot discover your authorization server:

```text
app.all('/mcp', handler);
app.get('/.well-known/oauth-protected-resource/mcp', handler);
app.get('/.well-known/oauth-protected-resource', handler);
```

The suffixed metadata path is `/.well-known/oauth-protected-resource` followed by the path of `resource`. Set `metadata.path` to replace it. The root path `/.well-known/oauth-protected-resource` is always served as well. Mount the handler before any body-parsing middleware. For other runtimes use `createMcpSdkHandler`, which takes a standard `Request` and returns a `Response`. For a different MCP stack use [`createMcpHandler`](./docs/Handler.md).

## Configuration

The client behind a handler can be configured in three ways. All three give the same result.

| Tier | You pass | Use it when |
| --- | --- | --- |
| Environment | Nothing. The handler reads the variables below. | The settings live in the environment, which is the common case. |
| Inline options | `domain`, `audience`, `clientId`, `clientSecret` and any other client option, directly on the handler options. | You want the settings visible in code. A value you leave out is still read from the environment. |
| Shared client | `client`, built with `createMcpClient`. | You use the same client elsewhere, for example `client.verifyAccessToken` in your own code. |

`createMcpHandler`, `createMcpSdkHandler` and `createNodeMcpHandler` accept all three. Passing `client` together with any inline client option throws `InvalidConfigurationError`, and the message names the options but never their values.

| Variable | Option | Required |
| --- | --- | --- |
| `AUTH0_DOMAIN` | `domain` | yes |
| `AUTH0_AUDIENCE` | `audience` | yes |
| `AUTH0_CLIENT_ID` | `clientId` | only to exchange tokens |
| `AUTH0_CLIENT_SECRET` | `clientSecret` | only to exchange tokens |

A variable that is unset, empty or only whitespace counts as unset. A missing `domain` or `audience` throws `InvalidConfigurationError` with a message such as `Missing MCP client option "domain": pass it explicitly or set the AUTH0_DOMAIN environment variable.`

To build a client from the environment yourself, use the helpers. `createMcpClient` itself never reads the environment.

```ts
import { createMcpClient, mcpClientOptionsFromEnv, resolveMcpClientOptions } from '@auth0/ai-mcp';

// Only what the environment provides. Required options may be missing.
const fromEnv = mcpClientOptionsFromEnv();
console.log(Object.keys(fromEnv));

// Explicit values win, the environment fills the rest, and a missing domain or audience throws.
export const client = createMcpClient(resolveMcpClientOptions({ scopeMatching: 'strict' }));
```

## Documentation

- [Handler and adapters](./docs/Handler.md): the framework-agnostic handler, the MCP SDK adapter, the Node adapter and how to write your own adapter.
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
