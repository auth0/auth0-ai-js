# Token Vault

`getTokenForConnection` exchanges the caller's Auth0 token for an access token issued by a federated provider such as Google or Slack, through Auth0 Token Vault. A tool can then call the third-party API as the user, and the user's original token never leaves the server.

## Using it in a tool

```ts
import { getCallerMcpClientOrThrow } from '@auth0/ai-mcp';

export async function listCalendarEvents(): Promise<unknown> {
  const mcpClient = getCallerMcpClientOrThrow();
  const token = await mcpClient.getTokenForConnection({ connection: 'google-oauth2' });

  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  return response.json();
}
```

`getTokenForConnection` takes:

| Option | Description |
| --- | --- |
| `connection` | Name of the connection that holds the caller's linked account. |
| `loginHint` | Optional hint that selects among several linked accounts. |

It resolves to a `ConnectionTokenResult`, the core client's connection token set:

| Field | Description |
| --- | --- |
| `accessToken` | The provider's access token. |
| `expiresAt` | Expiry in epoch seconds. |
| `scope` | The scope granted by the connection, or `undefined`. |
| `connection` | The connection you requested the token for. |
| `loginHint` | The hint passed with the request, if any. |

Pass `loginHint` when the user has more than one linked account for the connection.

The method rejects a result whose `expiresAt` is already in the past (or not a finite number), so a tool never receives a token that has expired. The rejection is the generic `The token operation failed.` error described in [Errors](./Errors.md), and the handler answers it with a 500 when it escapes a custom handler.

## Requirements

- `clientId` and `clientSecret` on `createMcpClient`.
- You enabled the Token Vault grant on that application, and you configured and enabled the federated connection for it.
- The application is a Custom API client, like the exchange client in step 2 of [Set up your tenant](https://github.com/auth0/auth0-ai-js/tree/main/examples/ai-mcp-server#set-up-your-tenant) in the example README. The package sends the caller's access token as the subject of this exchange, so that token must be issued for the API this client is tied to. A regular application is not known to work and can be refused, and the sanitized error does not say why, so read the reason in the tenant logs.
- The user has linked their external account through Auth0's connected accounts flow. Without a linked account the exchange fails.

For the tenant setup, follow the Auth0 guides:

- [Configure Token Vault](https://auth0.com/docs/secure/tokens/token-vault/configure-token-vault)
- [Connected Accounts for Token Vault](https://auth0.com/docs/secure/tokens/token-vault/connected-accounts-for-token-vault)

## Caching

With a `tokenStore` configured, the package caches connection tokens. The entry is keyed by the caller (issuer, client, subject, organization and session), the connection and the login hint, so one user never receives the token of another. A call without `loginHint`, with an empty one and with a value are separate entries. Without a store, or with your own `apiClient`, each call performs an exchange.

Two things to plan for:

- The entries are your users' tokens at the provider. Wrap a shared store with `createEncryptedTokenStore`.
- A cached token stays usable until its own expiry, even if the user unlinks the account in the meantime. A hit only checks that the caller's own token has not expired or is about to. See [What is cached](./TokenCaching.md#what-is-cached).

## Errors

Errors leave the request-scoped client with a fixed generic message, the class of the core error, and the original error as `cause`. The error itself keeps the `code`, `statusCode` and a copy of the `headers` of the failed token request. See [Errors](./Errors.md).
