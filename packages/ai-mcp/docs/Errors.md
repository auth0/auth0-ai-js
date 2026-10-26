# Errors

Errors fall into three groups: the classes this package exports, errors from the core client that pass through it, and configuration errors thrown when you create a client or handler.

All authentication errors extend `AuthError` from `@auth0/auth0-api-js`, which carries a `code`, an optional `statusCode` and optional `headers`.

## Errors exported by `@auth0/ai-mcp`

| Class | `statusCode` | `code` | Thrown when |
| --- | --- | --- | --- |
| `UnauthenticatedError` | 401 | `invalid_token` | Protected code runs without an authenticated caller, for example outside a request context, `withToken` receives an expired token, or a token exchange finds that the caller's token has expired or is about to expire. |
| `InsufficientScopeError` | 403 | `insufficient_scope` | The caller lacks a scope that `requireScopes` checks. |
| `DownscopedTokenError` | 403 | `insufficient_scope` | An on-behalf-of token exchange succeeded but did not include every requested scope. A client credentials grant that falls short is a server configuration failure instead, see [On Behalf Of](./OnBehalfOf.md#client-credentials). |
| `ForeignCallerError` | none | none | `McpClient.withToken` receives a handle that this client did not issue. This is a programming error. It extends `Error`, not `AuthError`, so it is never turned into a challenge. |

Messages are generic by design:

- `InsufficientScopeError` never names the scopes in its message. Its `requiredScopes` property (a frozen list) is for server-side use such as logging.
- `DownscopedTokenError` carries no scope data, which keeps granted and requested scope sets out of responses and logs.
- `UnauthenticatedError` and `InsufficientScopeError` accept `headers`, which you can pass to your own response.

## What the handler returns

`createMcpHandler` turns failures into HTTP responses with a generic JSON body and, where RFC 6750 calls for it, a `WWW-Authenticate` challenge.

| Failure | HTTP status | `error` value |
| --- | --- | --- |
| No credential | 401 | none in the challenge |
| Malformed `Authorization` or `DPoP` header | 400 | `invalid_request` |
| `VerifyAccessTokenError` (bad signature, expired, wrong audience or issuer) | 401 | `invalid_token` |
| `MissingOrganizationError`, `OrganizationNotAllowedError` | 401 | `invalid_token` |
| `InvalidDpopProofError` | 401 | `invalid_dpop_proof` |
| DPoP nonce required | 401 | `use_dpop_nonce` |
| `InvalidRequestError` | 400 | `invalid_request` |
| Missing scope in `requiredScopes` | 403 | `insufficient_scope` |
| `UnauthenticatedError` thrown by your handler | 401 | `invalid_token` |
| `InsufficientScopeError` or `DownscopedTokenError` escaping a custom `createMcpHandler` handler | 403 | `insufficient_scope` |
| Anything else thrown by your handler, including core and network errors | 500 | none, generic body |

Only this package's three error classes become client-facing failures when they escape your handler. A failed token exchange or a `ForeignCallerError` is an internal error: the client gets a generic 500 and `onError` receives the real error. That includes an exchange that exceeds `requestTimeoutMs`. A discovery or JWKS fetch that exceeds it is different: core reports it as a failed token verification, so that request currently gets 401 `invalid_token`.

With the official MCP SDK's `McpServer` (`createMcpSdkHandler` and `createNodeMcpHandler`), the SDK turns an error thrown inside a tool callback into a tool result with `isError: true` and the error's own message, unchanged, so the error does not reach the handler and the HTTP status stays 200. The message is generic for the errors this package throws and for errors from the request-scoped client. That includes `DownscopedTokenError` from a downscoped exchange. An error thrown by your own tool code reaches the caller with whatever message you gave it. Catch errors in the tool when you want control over the message.

**Warning.** Do not put secrets, tokens or internal details (hostnames, query text, stack information) in the message of an error thrown from your own tool code. The SDK copies the message into the tool result that the caller sees.

## Core errors

These come from `@auth0/auth0-api-js` and keep their class when they pass through the package, except that `VerifyAccessTokenError` raised during an exchange is reported as `UnauthenticatedError` (see below).

| Class | `statusCode` | `code` |
| --- | --- | --- |
| `VerifyAccessTokenError` | 401 | `verify_access_token_error` |
| `MissingOrganizationError` | 401 | `missing_organization` |
| `OrganizationNotAllowedError` | 401 | `organization_not_allowed` |
| `InvalidDpopProofError` | 400 | `invalid_dpop_proof` |
| `InvalidRequestError` | 400 | `invalid_request` |

`MissingOrganizationError` and `OrganizationNotAllowedError` extend `VerifyAccessTokenError`. Their `code` is for application logic and is never written to the challenge. Failures from the token endpoint, such as `TokenExchangeError` and `TokenByClientCredentialsError`, are also core classes.

A request-scoped client method sanitizes the errors it throws: it replaces the message with `The token operation failed.`, keeps the class, `code`, `statusCode` and `headers`, and attaches the original error as `cause`. One exception: a core `VerifyAccessTokenError` raised during an exchange, which means the caller's token expired or is about to expire, is reported as `UnauthenticatedError` (HTTP 401 when it reaches the handler). The package's own errors above pass through unchanged. Never serialize `cause` into a response.

## Configuration errors

`InvalidConfigurationError` (from `@auth0/auth0-api-js`) is thrown at construction time when:

- `scopeMatching` is `'non_strict'` and `tokenStore` is missing or not an indexed store,
- you pass `apiClient` together with `clientId`, `clientSecret`, `scopeMatching`, `organizationPolicy`, `organizationId`, `dpop` or `requestTimeoutMs`,
- `requestTimeoutMs` is not a finite number greater than 0 and at most 2147483647,
- `organizationId` is set while `organizationPolicy` is not `'required'`,
- `createEncryptedTokenStore` receives a `secret` shorter than 32 characters,
- `MemoryIndexedTokenStore` receives a `maxEntries` that is not a positive integer,
- `createMcpHandler` receives an invalid `metadata.path` or `realm`.

Handling an error in a tool:

```ts
import {
  DownscopedTokenError,
  InsufficientScopeError,
  UnauthenticatedError,
  getCallerMcpClientOrThrow,
} from '@auth0/ai-mcp';

export async function callDownstream() {
  try {
    const token = await getCallerMcpClientOrThrow().getTokenOnBehalfOf({
      audience: 'https://reports-api.example.com',
      scope: 'read:reports',
    });
    return { content: [{ type: 'text' as const, text: token.grantedScopes.join(' ') }] };
  } catch (error) {
    if (error instanceof DownscopedTokenError || error instanceof InsufficientScopeError) {
      return { isError: true as const, content: [{ type: 'text' as const, text: 'Not permitted.' }] };
    }
    if (error instanceof UnauthenticatedError) {
      throw error;
    }
    console.error('downstream call failed', error instanceof Error ? error.name : 'unknown');
    return { isError: true as const, content: [{ type: 'text' as const, text: 'The request failed.' }] };
  }
}
```
