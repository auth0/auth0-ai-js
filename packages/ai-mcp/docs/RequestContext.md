# Request context

Tool code needs to know who is calling without receiving the caller as an argument on every function. The request handler binds the caller to the request with Node's `AsyncLocalStorage`, and the functions below read it back.

The context holds two things:

- `principal`: the authenticated caller. See [Token verification](./TokenVerification.md#the-principal).
- `mcpClient`: a `RequestScopedMcpClient` bound to this caller's verified token.

## Reading the context

| Function | Returns |
| --- | --- |
| `getRequestContext()` | The whole `RequestContext`, or `undefined` outside a request. |
| `getCallerPrincipal()` | The `Principal`, or `undefined` outside a request. |
| `getCallerMcpClient()` | The `RequestScopedMcpClient`, or `undefined` outside a request. |
| `getCallerMcpClientOrThrow()` | The `RequestScopedMcpClient`. Throws `UnauthenticatedError` outside a request. |

```ts
import { getCallerMcpClientOrThrow, getCallerPrincipal } from '@auth0/ai-mcp';

export async function describeCaller(): Promise<string> {
  const principal = getCallerPrincipal();
  if (principal === undefined) {
    return 'anonymous';
  }
  const mcpClient = getCallerMcpClientOrThrow();
  return `${principal.sub} via ${mcpClient.getPrincipal().clientId ?? 'unknown client'}`;
}
```

The context is visible to everything the handler starts, including code after `await`, timers and promise chains. Concurrent requests do not see each other's context, and nested contexts restore the outer one when the inner one finishes.

## The request-scoped client

`RequestScopedMcpClient` is what tool code uses to get tokens. It always acts for the caller of the current request.

| Method | Purpose |
| --- | --- |
| `getTokenOnBehalfOf({ audience, scope? })` | Exchanges the caller's token for a downstream token. See [On Behalf Of](./OnBehalfOf.md). |
| `getClientCredentialsToken({ audience, scope? })` | Gets a token for the server itself. See [client credentials](./OnBehalfOf.md#client-credentials). |
| `getTokenForConnection({ connection, loginHint? })` | Gets a federated provider token. See [Token Vault](./TokenVault.md). |
| `getPrincipal()` | Returns the caller's `Principal`. |

The verified access token is held privately by the implementation. The object is frozen, has no property that holds the token, and exposes no way to read the token, so tool code cannot forward or log it by accident.

Each token method rejects a result that is already expired, with the same generic error. Errors that leave the request-scoped client carry a fixed generic message. They keep the original class, `code` and `statusCode` so `instanceof` checks and status mapping still work (a core `VerifyAccessTokenError` raised during an exchange becomes `UnauthenticatedError`, because the caller's token expired), and the original error is available as `cause` for server-side diagnostics. Do not serialize `cause` into a response.

## Setting the context yourself

If you build your own transport, call `runWithRequestContext` after verifying the token. See the example in [Token verification](./TokenVerification.md#verifying-a-token-yourself).

```ts
import { getCallerPrincipal, runWithRequestContext } from '@auth0/ai-mcp';
import type { RequestContext } from '@auth0/ai-mcp';

export function readSubject(context: RequestContext): string | undefined {
  return runWithRequestContext(context, () => getCallerPrincipal()?.sub);
}
```

## Outside the handler

Work that runs outside any request, such as a job queue consumer, has no request context, and `getCallerPrincipal()` returns `undefined` there. A request-scoped client stops working once the caller's token expires, so do not keep one beyond the request. Pass the job what it needs explicitly.
