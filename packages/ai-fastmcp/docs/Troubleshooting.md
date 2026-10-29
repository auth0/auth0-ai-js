# Troubleshooting

Find the symptom, then read the cause and the fix. The messages are the ones the package produces. For the full list of responses, see [Errors and status codes](./Errors.md).

## The server does not start

`createFastMcpAuth` validates its options when you call it and throws `InvalidConfigurationError`. The server stops at startup, before it takes a request.

| Message | Cause and fix |
| --- | --- |
| `Missing MCP client option "domain": pass it explicitly or set the AUTH0_DOMAIN environment variable.` | The domain is in neither the options nor the environment. Set `AUTH0_DOMAIN` or pass `domain`. The same message exists for `"audience"` and `AUTH0_AUDIENCE`. |
| `Invalid configuration: "client" cannot be combined with "domain". Pass either a client or client options.` | You passed `client` and an inline client option. Use one of the two. The message names the option. |
| `Invalid configuration: "resource" must equal the client audience` | `resource` and the audience differ, so clients would be sent to a server that refuses their tokens. Remove `resource`, or make it equal the audience. A trailing slash counts as a difference. |
| `Invalid configuration: the path of "resource" ("/mcp") must equal "endpoint" ("/other") or be empty` | FastMCP serves the metadata document at the well-known path followed by `endpoint`, so the path of the resource must be the endpoint. Set `endpoint` to the path of the resource, and pass the same value to `server.start`. |
| `Invalid configuration: "endpoint" must be a normalized absolute path such as "/mcp"` | The endpoint is `/`, has no leading slash, ends in a slash, or has a query or fragment. |
| `Invalid configuration: "realm" must be a non-empty string without quotes, backslashes or control characters.` | The realm cannot be written into a challenge. |
| `Invalid configuration: "sessionBinding.maxSessions" must be a positive number.` | A binding limit is zero, negative or not a number. The same message exists for `ttlMs`. |
| `Invalid configuration: DPoP mode "required" is not supported by the FastMCP adapter` | The adapter accepts Bearer tokens only. Use the default DPoP mode. See [DPoP](./DPoP.md). |

Setting the audience to an identifier that is not an absolute `http` or `https` URL, such as `urn:acme:mcp`, also throws. Name your Auth0 API with the public URL of the server.

## 401 and invalid_token with a token that looks fine

Every failed verification returns the same response, `The access token is invalid or has expired.`, so the response does not say which check failed. Check these first:

- **Audience.** The `aud` claim must equal `AUTH0_AUDIENCE` exactly, including the path and the trailing slash. A token for another API, or an ID token, has a different `aud`.
- **Issuer.** The `iss` claim must be `https://<domain>/`, built from the domain you configured, with the trailing slash.
- **Expiry.** The `exp` claim must be in the future.
- **Subject.** The token needs a `sub` claim.
- **Organization.** With `organizationPolicy: "required"`, the token needs an `org_id` claim.

To see the exact reason, verify the token with the same settings in a script:

```ts
import { createMcpClient } from "@auth0/ai-mcp";

const client = createMcpClient({
  domain: "your-tenant.us.auth0.com",
  audience: "https://mcp.example.com/mcp",
});

try {
  await client.verifyAccessToken({ accessToken: process.env.ACCESS_TOKEN ?? "" });
  console.log("The token is valid.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
}
```

For a token with the wrong audience the message reads `unexpected "aud" claim value`. The message for a wrong issuer names `iss`, and for an expired token it names `exp`.

If valid tokens suddenly fail, check that the server can reach the tenant. The adapter reports a failure to fetch the discovery document or the keys the same way. See [Errors and status codes](./Errors.md#a-tenant-that-cannot-be-reached).

## 401 Authentication is required.

The response has no `error` value in its challenge. The request had no `Authorization` header, or the header did not use the `Bearer` scheme. A proxy that strips the header produces the same symptom. Send `Authorization: Bearer <token>`.

## 401 DPoP is not supported by this server.

The client sent a `DPoP` header. The text `DPoP-bound access tokens are not supported by this server.` means the token itself is bound to a key. Configure the client to request Bearer tokens. See [DPoP](./DPoP.md).

## 400 The request is malformed.

The `Authorization` header is malformed. A common cause is a token with a space in it, for example when a shell variable holds two words. Print the header you send.

## 403 insufficient_scope

You created the server with `requiredScopes`, and the token lacks some of them. The `scope` parameter of the challenge lists the missing ones. Grant the scopes to the application in your Auth0 tenant, and make the client request them when it signs the user in. Read the `scope` claim of the token to see what it holds.

## A tool answers Missing required scope with status 200

The tool uses `requiredScopes` in `withAuth0Execute`, and the caller lacks the scope. The text names the missing scopes and the status is 200 by design, so the client can read the reason. See [Tools](./Tools.md#scopes-for-one-tool).

## Unknown tool for a tool that exists

The tool has `canAccess: requireScopes(...)` and the caller lacks the scope. FastMCP hides the tool from the list and refuses a direct call. Give the caller the scope, or use `requiredScopes` in `withAuth0Execute` if you want a message that names the scope.

## Tool execution failed.

The wrapper replaced an error that it does not show to the client. The original error goes to the `onError` option of `withAuth0Execute`, so add one and read it:

- A `MissingClientAuthError` means the exchange needs `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` (or `clientId` and `clientSecret`), and the server has none.
- A `TokenExchangeError` means your tenant refused the exchange or the request failed. Its `cause` holds the tenant's answer. Check that the application has permission to exchange tokens for that audience, and that the audience is an API of your tenant.
- Another error is a bug in your tool or a failure of a service it calls.

## A UserError shows up as Tool execution failed.

The wrapper recognizes a FastMCP `UserError` with `instanceof`, so it passes through only an error from the same copy of `fastmcp` that `@auth0/ai-fastmcp` uses. If your application resolves a second copy, the wrapper treats your `UserError` like any other error, replaces its message and hands it to `onError`. `fastmcp` is a peer dependency so that both sides share one copy. Run `npm ls fastmcp` and make your package manager install a single copy.

## The token exchange did not grant the requested scopes.

The exchange worked, but the tenant granted fewer scopes than the tool asked for. Grant the missing scopes to the application that performs the exchange, or ask for fewer.

## 403 The session belongs to a different caller.

A stateful server received a valid token for one subject on a session that another subject used first. A client that switches users has to start a new session. If your clients cannot do that, or you run several instances, use the stateless mode. See [Stateless and stateful servers](./StatelessAndStateful.md).

## The accessors return undefined, or No authenticated request context.

The tool is not wrapped. `getCallerPrincipal()` and `getCallerMcpClient()` return `undefined`, and `getCallerMcpClientOrThrow()` throws `No authenticated request context.`, outside `withAuth0Execute`. Wrap the `execute` function, or read `context.session` instead. See [Tools](./Tools.md#withauth0execute).

## The resource_metadata URL in a challenge returns 404

The challenge points at `/.well-known/oauth-protected-resource` followed by the endpoint you gave `createFastMcpAuth`, while FastMCP serves the document at that path followed by the endpoint you gave `server.start`. The two endpoints differ. Pass the same value to both.

## Calls to the tenant hang

The client limits each request to the tenant with `requestTimeoutMs`. A discovery or key request that exceeds it ends in a 401 `invalid_token`, and an exchange that exceeds it ends in `Tool execution failed.`. Set `requestTimeoutMs` to a value that fits your tenant's latency.

## A tool result says Unrecognized key: "_meta"

The text looks like `Tool 'admin' execution failed:` followed by a list that contains `Unrecognized key: "_meta"`. The FastMCP release is older than 4.7.0, whose result schema does not allow the `_meta` field that this package puts on its tool errors. Install FastMCP 4.7.0 or later. See [Compatibility](./Compatibility.md).
