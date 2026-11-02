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

**The environment.** Call it with no argument (an empty object works the same) and the four values come from these variables:

| Variable | Needed |
| --- | --- |
| `AUTH0_DOMAIN` | Always. The tenant domain without a scheme. |
| `AUTH0_AUDIENCE` | Always. The identifier of your API in Auth0, which is the public URL of the MCP endpoint. |
| `AUTH0_CLIENT_ID` | Only when a tool exchanges tokens. |
| `AUTH0_CLIENT_SECRET` | Only when a tool exchanges tokens. |

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth();
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
- **`endpoint`** is the path FastMCP serves the MCP route on. It defaults to the path of the audience when the audience has one (`/api/mcp` for `https://mcp.example.com/api/mcp`), and to `/mcp` when the audience is an origin only. `createFastMcpAuth` returns the chosen value as `auth.endpoint`, a read-only property that is not enumerable, so `...auth` does not hand it to `new FastMCP`. Pass it to `server.start`, so the path appears once, in the audience:

```ts
import { FastMCP } from "fastmcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

const auth = createFastMcpAuth({
  domain: "your-tenant.us.auth0.com",
  audience: "https://mcp.example.com/api/mcp",
});
const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });

await server.start({
  transportType: "httpStream",
  httpStream: { port: 3000, stateless: true, endpoint: auth.endpoint },
});
```

You can also set `endpoint` yourself. It must equal the path of the audience, and `createFastMcpAuth` throws when it does not.

FastMCP serves the metadata document at `/.well-known/oauth-protected-resource` and at that path followed by the endpoint, for example `/.well-known/oauth-protected-resource/api/mcp`. A client finds the document by putting the path of the resource after the well-known path (RFC 9728). That works only when the path of the resource is the endpoint or is empty, so `createFastMcpAuth` throws `InvalidConfigurationError` for any other path. The message reads `the path of "resource" ("/mcp") must equal "endpoint" ("/other") or be empty` and ends with the fix: `Set "endpoint" to the path of "resource".`

You may use a resource without a path. With the audience `https://mcp.example.com` and the default endpoint, the document is served at the root well-known path, and the challenge names that path. The document then does not say where the MCP route is, so prefer an audience that includes the path.

`endpoint` must be an absolute path such as `/mcp`, without a trailing slash, query or fragment. `/` and values like `mcp` or `/mcp/` throw.

An audience whose path ends in a slash, such as `https://mcp.example.com/mcp/`, also throws `InvalidConfigurationError`. FastMCP serves `/mcp` and not `/mcp/`, so the resource the metadata publishes would answer 404. Use the audience without the trailing slash, here and in the API identifier in Auth0. An audience that is an origin only, such as `https://mcp.example.com/`, stays valid.

### A request on another path

If `server.start` gets an endpoint other than `auth.endpoint`, the server starts, and the first request that reaches `authenticate` on the other path makes the adapter write one warning to the server's standard error stream: it names the path that arrived and the configured endpoint. The warning appears once per path and process, shows the path only and never the query string, and changes no response. The metadata document and the challenge still name the configured endpoint, so fix the call to `server.start`. Requests for the endpoint, the well-known metadata routes and the legacy SSE routes (`/sse`, `/messages`) do not trigger it.

### Behind a proxy

Set the audience to the public URL, the one clients use. FastMCP does not follow `X-Forwarded-Host` or `X-Forwarded-Proto` when it serves the document, so the published resource is always the one you configured.

## Metadata

The metadata document tells clients which authorization server to use.

| Option | Document field | Default |
| --- | --- | --- |
| `resource` | `resource` | The audience. |
| `authorizationServers` | `authorization_servers` | `["https://<domain>/"]`, built from the tenant domain. |
| `metadata.scopesSupported` | `scopes_supported` | The `requiredScopes`, or left out when there are none. |
| `metadata.resourceName` | `resource_name` | Left out. |
| `metadata.resourceDocumentation` | `resource_documentation` | Left out. |

The document always contains `bearer_methods_supported` with the value `["header"]`. Set `authorizationServers` yourself when the issuers you advertise differ from `https://<domain>/`, or when you advertise more than one.

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

`requiredScopes` lists scopes every request must carry. A token that lacks one gets HTTP 403 before any tool runs. The challenge has `error="insufficient_scope"` and a `scope` parameter that lists only the missing scopes. A token with all of them passes. A request without credentials gets a 401 whose challenge names all of them in `scope`, and the metadata document lists them as `scopes_supported` unless you set `metadata.scopesSupported`, so the challenge and the document always agree.

Each entry is split on whitespace, so `"read write"` means two scopes, and a repeated scope counts once. A blank entry or one that is not a string makes `createFastMcpAuth` throw `InvalidConfigurationError`.

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({ requiredScopes: ["mcp:access"] });
```

Use this for a scope that gates the whole server. For a scope that gates one tool, see [Tools](./Tools.md#scopes-for-one-tool).

## Realm

`realm` sets the `realm` parameter of every challenge, for example `Bearer realm="orders"`. It must be a non-empty string without quotes, backslashes or control characters, or `createFastMcpAuth` throws `InvalidConfigurationError`.

## Error observer

`onError` receives the raw error whenever `authenticate` answers 500. It is also the default for every tool wrapped with `withAuth0Execute`: when the wrapper replaces an error and the tool has no `onError` of its own, the hook of `createFastMcpAuth` receives it. A hook passed to `withAuth0Execute` overrides this one for that tool. While a hook is in effect, the default log line (see [Errors](./Errors.md#errors-inside-tools)) is not written, so the hook owns the reporting.

The hook receives the raw error on the server only. The error never reaches the response or the tool result, and it can carry details that are not for the client, so log the error name and what you need to debug, and keep tokens out of your logs. The adapter ignores a hook that throws or returns a rejected promise.

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
| `endpoint` | Path of the MCP route. Defaults to the path of the audience, else `/mcp`. Exposed as `auth.endpoint`. |
| `authorizationServers` | Issuers published in the metadata document. |
| `requiredScopes` | Scopes every request must carry. Also the default `scopes_supported` and the `scope` of the 401 challenge. |
| `realm` | The `realm` of challenges. |
| `metadata` | `scopesSupported`, `resourceName` and `resourceDocumentation` for the document. |
| `sessionBinding` | `false`, or `{ maxSessions, ttlMs }`. |
| `onError` | Observer for the raw error of every 500 and the default for every wrapped tool. |
