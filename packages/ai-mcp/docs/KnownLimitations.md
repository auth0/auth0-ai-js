# Known limitations

## A token in its last seconds passes the gate but may not be exchanged

Token verification applies no clock tolerance to the `exp` claim: the handler accepts a token until the moment it expires. The five second rule belongs to the cache path of the On Behalf Of exchange, so it applies only when a `tokenStore` is set. With a store, the exchange refuses a subject token that expires within the next five seconds, and the cache treats an entry within five seconds of expiry as a miss.

The two cases differ in the error a tool sees:

- **With a `tokenStore`.** A request that arrives with a token in its last five seconds passes authentication and runs your tool, but any token exchange inside that tool fails as `UnauthenticatedError` before a request reaches Auth0. Under the MCP SDK adapters that is a tool result with `isError: true` and HTTP 200.
- **Without a `tokenStore`.** The five second rule does not run. A token with three seconds left is exchanged normally. A token that expires before Auth0 handles the request is refused by Auth0, and the call fails with the generic token operation error, not `UnauthenticatedError`.

A handle whose token has already expired is refused earlier: `McpClient.withToken` throws `UnauthenticatedError` for it. The handler never hits this, because it calls `withToken` right after verification, but code that keeps a `VerifiedCaller` around (a queue consumer, for example) does.

The client recovers by refreshing its access token and retrying. This does not affect tools that do not exchange tokens. This package adds no workaround, so plan for it in the error path of tools that call downstream APIs.

## Verified claims cannot cross a process boundary

`McpClient.verifyAccessToken` returns an opaque `VerifiedCaller` handle. The core client recognizes verified claims by object identity rather than by content, so the claims cannot be serialized, sent to another process and trusted there. The handle redacts itself when logged or serialized, and `withToken` rejects anything it did not issue itself.

If one process verifies a request and a different process needs to exchange the token, for example across a queue, the second process must verify the access token again with its own `McpClient`.

## The encrypted store has no secret rotation

`createEncryptedTokenStore` supports a single secret. There is no key identifier and no way to read entries written with an old secret while writing new ones. Changing the secret makes every existing entry unreadable, and the cache treats unreadable entries as misses, so the effect is a burst of fresh exchanges after a change. Rotate the secret during a quiet period, or flush the inner store when you change it.

## `requireBearerAuth` does not restore the request context

`asTokenVerifier` adapts an `McpClient` to the MCP SDK's `OAuthTokenVerifier`, for use with the `requireBearerAuth` middleware from `@modelcontextprotocol/express` (or the web standard `requireBearerAuth` from `@modelcontextprotocol/server`). Prefer `createMcpHandler`, `createMcpSdkHandler` or `createNodeMcpHandler`. The shim has these differences:

- **No request context.** `requireBearerAuth` does not run this package's context binding. Inside your routes `getRequestContext()`, `getCallerPrincipal()` and `getCallerMcpClient()` return `undefined`, and no request-scoped client exists. To get them back, call `client.verifyAccessToken` and `client.withToken` in your own wrapper and use `runWithRequestContext`, or switch to the handler.
- **The SDK's challenge behavior.** The middleware answers a missing credential with `error="invalid_token"`, although RFC 6750 section 3.1 says to send no error value in that case. It echoes the SDK's own messages in `error_description` and lists the configured scopes instead of only the missing ones.
- **Bearer only.** The shim does not know DPoP. A DPoP-bound token fails verification.
- **`resource` and `expectedResource`.** `AuthInfo.resource` is the client audience when that is an absolute `http` or `https` URL, so the SDK's `expectedResource` option can take the same value. For any other audience, such as a URN, the shim leaves `resource` out and `expectedResource` rejects every token, so do not set it. Each call returns a new `URL`, which a caller may change without affecting later calls.

Failed verification maps to the SDK's `OAuthError` with code `invalid_token`, a 403 from the core maps to an `OAuthError` with code `insufficient_scope`, and everything else is rethrown so the middleware answers 500. The v2 middleware answers 500 for any error that is not an `OAuthError`, so a verifier of your own must throw `OAuthError`, not the error classes of the v1 SDK.

## The MCP SDK adapter is stateless

`createMcpSdkHandler` and `createNodeMcpHandler` run the SDK v2 web standard Streamable HTTP transport in stateless mode with JSON responses:

- Each POST gets one JSON body and no session id, so any instance can serve any request.
- The adapter creates the server per request and closes it when the request ends. A streamed response would be cut off, so streaming is not offered.
- Server-to-client notifications and standalone event streams (GET requests) are not available.
- Tools that depend on state kept inside an SDK session must keep that state elsewhere.

If you need sessions or streaming, use `createMcpHandler` and manage the transport yourself.

## The MCP SDK adapter speaks only the earlier handshake

`createMcpSdkHandler` and `createNodeMcpHandler` serve the `initialize` handshake. They do not serve the 2026-07-28 protocol revision, and this package makes no claim of support for it. A `server/discover` request gets a JSON-RPC `Method not found` error. A client that negotiates the revision on its own has to fall back to `initialize`, and a client pinned to the 2026-07-28 revision cannot connect. The SDK's own `createMcpHandler` serves both revisions. Moving the adapters to it is a follow-up.

## A tenant outage answers 401

When the discovery document or the key set of your tenant cannot be fetched (the request fails, times out or gets an error status), the core client reports the token as invalid. The handler answers 401 with `error="invalid_token"` and does not call `onError`. During an outage a client can therefore start a new authorization although its token is fine, and alerts on 5xx responses or on `onError` stay silent. The cause is in the core library, `@auth0/auth0-api-js`, which has to report the failure as its own error before this package can answer 503. That change is tracked as a follow-up for the core library and is not part of this release. Until then, watch the reachability of the discovery and key set URLs of your tenant separately, because nothing on the response or in `onError` tells an outage from a bad token. A key set fetch also stops after 5 seconds at most, because the JWT library caps it there, so a larger `requestTimeoutMs` does not lengthen it; see [Timeouts](./OnBehalfOf.md#timeouts).

## Other things to know

- `MemoryIndexedTokenStore` lives in one process. Workers do not share it, and it is empty after a restart.
- Client credentials tokens and Token Vault tokens are cached when you configure a `tokenStore`, and are not cached when you pass your own `apiClient`. A cached Token Vault token stays usable until its own expiry, whatever happens to the user's linked account. See [What is cached](./TokenCaching.md#what-is-cached).
- The core client stores an On Behalf Of result before this package checks its expiry. If the authorization server returns a token that is expired or expires within five seconds, the call fails, and that entry can stay in the token store. The cache treats such entries as misses, so it is never served.
- The handler cannot serve an Auth0 API whose identifier is not the public URL of the server. See [resource and audience](./Handler.md#resource-and-audience).
- The exchange request to Auth0 carries no DPoP proof. See [DPoP](./TokenVerification.md#dpop).
- The handler routes nothing but the metadata document. Mount it only on the path that serves MCP.
- The metadata route sends no CORS headers. Add them in your framework if browser-based clients read the document.
- The SDK cannot change tenant settings. Settings that real MCP clients need, such as Client ID Metadata Document Registration, are yours to set. See [MCP clients and tenant settings](./McpClients.md).
