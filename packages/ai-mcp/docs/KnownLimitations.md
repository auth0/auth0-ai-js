# Known limitations

## A token in its last seconds passes the gate but cannot be exchanged

Token verification applies no clock tolerance to the `exp` claim: the handler accepts a token until the moment it expires. The On Behalf Of exchange is stricter. It refuses a subject token that expires within the next five seconds, and the cache treats an entry within five seconds of expiry as a miss.

A request that arrives with a token in its last five seconds therefore passes authentication and runs your tool, but any token exchange inside that tool fails. The client recovers by refreshing its access token and retrying. This does not affect tools that do not exchange tokens. This package adds no workaround, so plan for it in the error path of tools that call downstream APIs.

## Verified claims cannot cross a process boundary

`McpClient.verifyAccessToken` returns an opaque `VerifiedCaller` handle. The core client recognizes verified claims by object identity rather than by content, so the claims cannot be serialized, sent to another process and trusted there. The handle redacts itself when logged or serialized, and `withToken` rejects anything it did not issue itself.

If one process verifies a request and a different process needs to exchange the token, for example across a queue, the second process must verify the access token again with its own `McpClient`.

## The encrypted store has no secret rotation

`createEncryptedTokenStore` supports a single secret. There is no key identifier and no way to read entries written with an old secret while writing new ones. Changing the secret makes every existing entry unreadable, and the cache treats unreadable entries as misses, so the effect is a burst of fresh exchanges after a change. Rotate the secret during a quiet period, or flush the inner store when you change it.

## `requireBearerAuth` does not restore the request context

`asTokenVerifier` adapts an `McpClient` to the MCP SDK's `OAuthTokenVerifier`, for use with the SDK's `requireBearerAuth` Express middleware. Prefer `createMcpHandler`, `createMcpSdkHandler` or `createNodeMcpHandler`. The shim has these differences:

- **No request context.** `requireBearerAuth` does not run this package's context binding. Inside your routes `getRequestContext()`, `getCallerPrincipal()` and `getCallerMcpClient()` return `undefined`, and no request-scoped client exists. To get them back, call `client.verifyAccessToken` and `client.withToken` in your own wrapper and use `runWithRequestContext`, or switch to the handler.
- **The SDK's challenge behavior.** The middleware answers a missing credential with `error="invalid_token"`, although RFC 6750 section 3.1 says to send no error value in that case. It echoes the SDK's own messages in `error_description` and lists the configured scopes instead of only the missing ones.
- **Bearer only.** The shim does not know DPoP. A DPoP-bound token fails verification.

Failed verification maps to the SDK's invalid token error, a 403 from the core maps to its insufficient scope error, and everything else is rethrown so the middleware answers 500.

## The MCP SDK adapter is stateless

`createMcpSdkHandler` and `createNodeMcpHandler` run the SDK's Streamable HTTP transport in stateless mode with JSON responses:

- Each POST gets one JSON body and no session id, so any instance can serve any request.
- The adapter creates the server per request and closes it when the request ends. A streamed response would be cut off, so streaming is not offered.
- Server-to-client notifications and standalone event streams (GET requests) are not available.
- Tools that depend on state kept inside an SDK session must keep that state elsewhere.

If you need sessions or streaming, use `createMcpHandler` and manage the transport yourself.

## Other things to know

- `MemoryIndexedTokenStore` lives in one process. Workers do not share it, and it is empty after a restart.
- Client credentials tokens and Token Vault tokens are not cached by this package.
- The exchange request to Auth0 carries no DPoP proof. See [DPoP](./TokenVerification.md#dpop).
- The handler routes nothing but the metadata document. Mount it only on the path that serves MCP.
- The metadata route sends no CORS headers. Add them in your framework if browser-based clients read the document.
- The SDK cannot change tenant settings. Settings that real MCP clients need, such as Client ID Metadata Document Registration, are yours to set. See [MCP clients and tenant settings](./McpClients.md).
