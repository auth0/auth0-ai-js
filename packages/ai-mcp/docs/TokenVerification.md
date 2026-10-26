# Token verification

Every request to a protected MCP server carries an access token that Auth0 issued for your server. `McpClient.verifyAccessToken` checks it, and the result is a `Principal` that describes the caller. Request handlers call it for you. This page describes what it does and how to call it yourself.

## What verification checks

Verification is done by the core client, `@auth0/auth0-api-js`. It checks the signature against the tenant's JWKS, the issuer, the audience (the `audience` you passed to `createMcpClient`), and the expiry. On top of that, the `McpClient` enforces the [organization policy](./OrganizationPolicy.md) and the DPoP rules you configured.

The core client applies no clock tolerance to the `exp` claim. See [known limitations](./KnownLimitations.md#a-token-in-its-last-seconds-passes-the-gate-but-cannot-be-exchanged).

## The Principal

A `Principal` describes the caller. It holds no credential and is safe to log. The object and its arrays are frozen.

| Field | Type | Source |
| --- | --- | --- |
| `sub` | `string` | The `sub` claim. Never blank. |
| `expiresAt` | `number` | The `exp` claim, in epoch seconds. |
| `scopes` | `readonly string[]` | The space-delimited `scope` claim. Empty when the claim is absent. |
| `permissions` | `readonly string[] \| null` | The `permissions` claim (RBAC). `null` when the claim is absent, which means permissions are unknown. An empty array means the caller has none. |
| `clientId` | `string \| null` | The `client_id` claim, falling back to `azp`. `null` when neither is present. |
| `orgId` | `string \| null` | The `org_id` claim. `null` outside an organization context. |

`buildPrincipal(claims)` builds a `Principal` from claims you have already verified. It does not verify anything and throws `UnauthenticatedError` when `sub` is blank or `exp` is missing. It reads every claim as an own property, so it ignores values inherited through the prototype chain.

Scope checks use the `scopes` field only. The `permissions` claim is there for your own logic. Neither `requireScopes` nor the handler consults it.

## The token inside tools

Tools never receive the raw access token. On the MCP SDK adapter, `extra.authInfo.token` is intentionally an empty string, and tools call downstream APIs through the request-scoped client. The MCP SDK still exposes the raw request headers, including `Authorization`, to tools through `extra.requestInfo.headers`, so tool code must not log or forward headers.

## Verifying a token yourself

The handler does this for you. Call `verifyAccessToken` directly when you build your own transport:

```ts
import { createMcpClient, runWithRequestContext, UnauthenticatedError } from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
});

export async function serve<T>(accessToken: string, work: () => Promise<T>): Promise<T> {
  const caller = await client.verifyAccessToken({ accessToken, scheme: 'bearer' });
  if (caller.principal.scopes.length === 0) {
    throw new UnauthenticatedError('The token carries no scopes.');
  }
  const mcpClient = client.withToken(caller);
  return runWithRequestContext({ principal: caller.principal, mcpClient }, work);
}
```

`verifyAccessToken` returns a `VerifiedCaller`, an opaque handle that exposes only the `principal`. The verified token stays inside the client that issued the handle, and the handle redacts itself when you serialize or log it. `withToken` accepts only handles from the same client. A copy, a hand-built object or a handle from another client throws `ForeignCallerError`, which indicates a programming error and maps to a 500. `withToken` throws `UnauthenticatedError` when the token has expired.

Errors from the core client, such as `VerifyAccessTokenError`, propagate unchanged. See [Errors](./Errors.md).

## DPoP

DPoP (RFC 9449) binds an access token to a key held by the client. You configure it with the `dpop` option of `createMcpClient`, which the package forwards to the core client:

```ts
import { createMcpClient } from '@auth0/ai-mcp';

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  dpop: {
    mode: 'required',
    iatOffset: 300,
    iatLeeway: 30,
  },
});
```

| Setting | Meaning |
| --- | --- |
| `mode: 'allowed'` (default) | Accepts Bearer and DPoP. The client validates the proof and binding when the request uses DPoP. |
| `mode: 'required'` | Accepts DPoP only. The metadata document sets `dpop_bound_access_tokens_required`. |
| `mode: 'disabled'` | Bearer only. |
| `iatOffset` | Maximum age of a proof's `iat` claim, in seconds. Defaults to 300. |
| `iatLeeway` | Allowed future skew of a proof's `iat` claim, in seconds. Defaults to 30. |

### Supported

- **Incoming DPoP-bound access tokens.** The handler accepts `Authorization: DPoP <token>` with a `DPoP: <proof>` header and passes the proof, the HTTP method and the request URL to the core client for validation.
- **Mode-aware schemes.** The handler accepts and advertises Bearer, DPoP or both according to `dpop.mode`. A scheme the mode does not accept counts as no credential and gets a challenge without an error value.
- **Proof errors.** The handler answers a failed proof with 401 and `error="invalid_dpop_proof"` on the `DPoP` challenge. When the core client supplies a valid `DPoP-Nonce` value the handler returns it with `error="use_dpop_nonce"`, so the client can retry.
- **Metadata.** Unless the mode is `disabled`, the metadata document declares `ES256` in `dpop_signing_alg_values_supported`.
- **Exchange of a DPoP-bound token.** A DPoP-bound subject token can be exchanged on behalf of the caller, because the gate verified it and passes the verified claims to the core client.

### Not supported

- **DPoP on outgoing requests.** The token exchange request to Auth0 carries no DPoP proof, and this package does not request DPoP-bound downstream tokens. If the authorization server rejects the exchange, the error propagates to the tool.
- **Nonce issuing.** This package does not generate nonces. It relays one only when the core client supplies it. Without a usable nonce the response says `invalid_dpop_proof`.
- **Overriding the URL checked in the proof.** The handler checks `request.url`. See [Proxies](./Handler.md#proxies).
- **DPoP through the MCP SDK's `requireBearerAuth` shim.** `asTokenVerifier` verifies Bearer tokens only, so a DPoP-bound token fails verification there.
- **Passing your own `apiClient`.** The package cannot read the mode of a client you supply, so `McpClient.dpopMode` reports `'allowed'`. Build the client from options when challenges must reflect `'required'` or `'disabled'`.
- **`mode: 'disabled'` is not a rejection of DPoP-bound tokens.** The core client then ignores DPoP, so a DPoP-bound token presented as a Bearer token passes verification. Leave DPoP enabled unless you intend that.
