# Security notes

What the adapter does for you, what it leaves to you, and the limits to know before you deploy.

## What the adapter enforces

- **Authentication comes first.** `authenticate` runs before FastMCP handles a request. A request without a valid token for your audience gets an error response and never reaches a tool. The adapter rejects a token issued for another API of your tenant, because it checks the audience.
- **The session holds no credential.** `context.session` has the verified `principal`, the `scopes` and a request-scoped client. The access token is not a property of any of them, the session is frozen, and serializing it does not reveal the token.
- **Responses reveal no cause.** The text of a failed verification is fixed, and so is the text of every 4xx and 5xx body. The error that the verifier or the client raised never reaches the response. The wrapper replaces messages from inside a tool too, see [Errors and status codes](./Errors.md#errors-inside-tools).
- **The adapter accepts Bearer tokens only.** A request with a `DPoP` header, and a token that claims a key binding, get a 401. See [DPoP](./DPoP.md).
- **Scopes come from the `scope` claim.** Both the server-wide `requiredScopes` and the per-tool `requiredScopes` read it. `principal.permissions` carries the `permissions` claim for your own logic, and no scope check consults it.

## What stays your job

- **Send downstream APIs the exchanged token.** Get it from `session.mcpClient.getTokenOnBehalfOf`, which asks your tenant for a token issued for that API with the caller as subject. Do not forward the access token your server received. See [Tools](./Tools.md#calling-downstream-apis-for-the-caller).
- **Protect the store.** A token store holds credentials for your downstream APIs until they expire. Put a shared store behind `createEncryptedTokenStore` and keep its secret in a secret manager. See [Token caching](./TokenCaching.md).
- **Keep raw errors on the server.** `onError` hands you the original error. It can carry details that are not for the client, so log it on the server and keep it out of responses and out of tool results. Keep tokens and `Authorization` headers out of your logs.
- **Set `requiredScopes` for the scopes your server cannot do without.** Without it, any valid token for the audience passes `authenticate`, and each tool decides for itself.
- **Pick the mode on purpose.** Run stateless unless you need state. A stateful server relies on the session binding, which has limits. See [Stateless and stateful servers](./StatelessAndStateful.md).

## Public routes

FastMCP serves some routes without authentication, and this adapter does not change that:

- `/health` and `/ready`.
- The protected resource metadata, at `/.well-known/oauth-protected-resource` and at that path followed by the endpoint. It holds public information: the resource, the authorization servers and the scopes you chose to publish.

## Proxies and forwarded headers

FastMCP does not follow `X-Forwarded-Host` or `X-Forwarded-Proto`. The published resource is the one you configured, whatever the forwarding headers say. Set the audience to the public URL clients use. See [Configuration](./Configuration.md#behind-a-proxy).

## FastMCP's own auth option

Do not set the `auth` option of FastMCP together with this adapter. FastMCP documents it as a provider that configures `authenticate` and `oauth` itself, and this adapter supplies both. `createFastMcpAuth` returns exactly those two options for you to spread, and nothing else.

## Revocation

The adapter verifies a token locally, with the keys your tenant publishes. After it has fetched the discovery document and the keys, it makes no call to the tenant per request. Revoking a token at the tenant therefore does not stop this server from accepting it before it expires. Keep access token lifetimes short.
