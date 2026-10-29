# Configuration

`createFastMcpAuth(options)` takes two kinds of options: the settings of the Auth0 client that verifies tokens and exchanges them, and the options of the FastMCP adapter. It checks all of them when you call it, so a mistake stops the server at startup and not on the first request.

## Three ways to configure the client

Pick one. They are the same three ways the `@auth0/ai-mcp` handler offers.

**A client you built.** Use this when you share one client between this adapter and other code:

```ts
import { createMcpClient } from "@auth0/ai-mcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

const client = createMcpClient({
  domain: "your-tenant.us.auth0.com",
  audience: "https://mcp.example.com/mcp",
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
});

export const auth = createFastMcpAuth({ client });
```

**Inline options.** Use this when the settings live in your own configuration. Anything you leave out of `domain`, `audience`, `clientId` and `clientSecret` is read from the environment:

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({
  domain: "your-tenant.us.auth0.com",
  audience: "https://mcp.example.com/mcp",
  clientId: process.env.MY_CLIENT_ID,
  clientSecret: process.env.MY_CLIENT_SECRET,
});
```

**The environment.** Pass an empty object and the four values come from these variables:

| Variable | Needed |
| --- | --- |
| `AUTH0_DOMAIN` | Always. The tenant domain without a scheme. |
| `AUTH0_AUDIENCE` | Always. The identifier of your API in Auth0, which is the public URL of the MCP endpoint. |
| `AUTH0_CLIENT_ID` | Only when a tool exchanges tokens. |
| `AUTH0_CLIENT_SECRET` | Only when a tool exchanges tokens. |

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({});
```

A missing `domain` or `audience` throws `InvalidConfigurationError`. The message names the option and the variable, for example `Missing MCP client option "domain"`. A server that only verifies tokens does not need the client id and secret.

Passing `client` together with an inline client option throws `InvalidConfigurationError` that names the option, for example `Invalid configuration: "client" cannot be combined with "domain". Pass either a client or client options.`

### Other client options

Inline options accept everything `createMcpClient` accepts: `tokenStore`, `scopeMatching`, `organizationPolicy`, `organizationId`, `requestTimeoutMs` and `apiClient`. The `@auth0/ai-mcp` guides describe them. For example, `organizationPolicy: "required"` makes the adapter answer 401 to a token without an `org_id` claim. See [Token caching](./TokenCaching.md) for `tokenStore`.

The adapter accepts Bearer tokens only, so the `dpop` option has one useful value. See [DPoP](./DPoP.md).

## The resource, the audience and the endpoint

Three values must agree, and the adapter checks that they do.

- **`audience`** is the identifier of your API in Auth0. Access tokens must be issued for it, and the adapter rejects tokens for any other audience.
- **`resource`** is the URL clients use to reach your server. The metadata document publishes it. Leave it out and it defaults to the audience. If you set it, it must equal the audience, and `createFastMcpAuth` throws `InvalidConfigurationError` when it does not. An audience that is not an absolute `http` or `https` URL, such as `urn:acme:mcp`, cannot be served and throws the same error.
- **`endpoint`** is the path FastMCP serves the MCP route on. It defaults to `/mcp`. If you use another path, pass the same value to `createFastMcpAuth` and to `server.start`:

```ts
import { FastMCP } from "fastmcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

const auth = createFastMcpAuth({
  domain: "your-tenant.us.auth0.com",
  audience: "https://mcp.example.com/api/mcp",
  endpoint: "/api/mcp",
});
const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });

await server.start({
  transportType: "httpStream",
  httpStream: { port: 3000, stateless: true, endpoint: "/api/mcp" },
});
```

FastMCP serves the metadata document at `/.well-known/oauth-protected-resource` and at that path followed by the endpoint, for example `/.well-known/oauth-protected-resource/api/mcp`. A client finds the document by putting the path of the resource after the well-known path (RFC 9728). That works only when the path of the resource is the endpoint or is empty, so `createFastMcpAuth` throws `InvalidConfigurationError` for any other path. The message reads `the path of "resource" ("/mcp") must equal "endpoint" ("/other") or be empty` and ends with the fix: `Set "endpoint" to the path of "resource".`

You may use a resource without a path. With the audience `https://mcp.example.com` and the default endpoint, the document is served at the root well-known path, and the challenge names that path. Clients then have to know to call `/mcp` themselves, so prefer an audience that includes the path.

`endpoint` must be an absolute path such as `/mcp`, without a trailing slash, query or fragment. `/` and values like `mcp` or `/mcp/` throw.

### Behind a proxy

Set the audience to the public URL, the one clients use. FastMCP does not follow `X-Forwarded-Host` or `X-Forwarded-Proto` when it serves the document, so the published resource is always the one you configured.

## Metadata

The metadata document tells clients which authorization server to use.

| Option | Document field | Default |
| --- | --- | --- |
| `resource` | `resource` | The audience. |
| `authorizationServers` | `authorization_servers` | `["https://<domain>/"]`, built from the tenant domain. |
| `metadata.scopesSupported` | `scopes_supported` | Left out. |
| `metadata.resourceName` | `resource_name` | Left out. |
| `metadata.resourceDocumentation` | `resource_documentation` | Left out. |

The document always contains `bearer_methods_supported` with the value `["header"]`. Set `authorizationServers` yourself when you advertise a custom domain or more than one issuer. Each entry must match the `iss` claim of your tokens.

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({
  authorizationServers: ["https://login.example.com/"],
  metadata: {
    scopesSupported: ["read:orders", "write:orders"],
    resourceName: "Orders",
    resourceDocumentation: "https://docs.example.com/orders",
  },
});
```

The document and the `WWW-Authenticate` challenge are built from the same resource and endpoint, so the challenge always names a route that serves the document.

## Required scopes

`requiredScopes` lists scopes every request must carry. A token that lacks one gets HTTP 403 before any tool runs. The challenge has `error="insufficient_scope"` and a `scope` parameter that lists only the missing scopes. A token with all of them passes.

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({ requiredScopes: ["mcp:access"] });
```

Use this for a scope that gates the whole server. For a scope that gates one tool, see [Tools](./Tools.md#scopes-for-one-tool).

## Realm

`realm` sets the `realm` parameter of every challenge, for example `Bearer realm="orders"`. It must be a non-empty string without quotes, backslashes or control characters, or `createFastMcpAuth` throws `InvalidConfigurationError`.

## Error observer

`onError` receives the raw error whenever `authenticate` answers 500. The error never reaches the response. The adapter ignores a hook that throws or returns a rejected promise. Log the error name and what you need to debug, and keep tokens out of your logs.

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({
  onError: (error) => console.error("authenticate failed", error instanceof Error ? error.name : "unknown"),
});
```

## Session binding

`sessionBinding` configures the protection for stateful servers. See [Stateless and stateful servers](./StatelessAndStateful.md).

## All options

| Option | Meaning |
| --- | --- |
| `client` | A client from `createMcpClient`. Cannot be combined with the inline client options. |
| `domain`, `audience`, `clientId`, `clientSecret` | Inline client settings. Read from the environment when left out. |
| `tokenStore`, `scopeMatching`, `organizationPolicy`, `organizationId`, `requestTimeoutMs`, `apiClient` | Other client options, as in `createMcpClient`. |
| `resource` | Public URL of the server. Defaults to the audience and must equal it. |
| `endpoint` | Path of the MCP route. Defaults to `/mcp`. |
| `authorizationServers` | Issuers published in the metadata document. |
| `requiredScopes` | Scopes every request must carry. |
| `realm` | The `realm` of challenges. |
| `metadata` | `scopesSupported`, `resourceName` and `resourceDocumentation` for the document. |
| `sessionBinding` | `false`, or `{ maxSessions, ttlMs }`. |
| `onError` | Observer for the raw error of every 500. |
