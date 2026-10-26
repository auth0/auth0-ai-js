# Token Vault

`getTokenForService` exchanges the caller's Auth0 token for an access token issued by a federated provider such as Google or Slack, through Auth0 Token Vault. A tool can then call the third-party API as the user, and the user's original token never leaves the server.

## Using it in a tool

```ts
import { getCallerMcpClientOrThrow } from '@auth0/ai-mcp';

export async function listCalendarEvents(): Promise<unknown> {
  const mcpClient = getCallerMcpClientOrThrow();
  const token = await mcpClient.getTokenForService({ connection: 'google-oauth2' });

  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  return response.json();
}
```

`getTokenForService` takes:

| Option | Description |
| --- | --- |
| `connection` | Name of the connection that holds the caller's linked account. |
| `loginHint` | Optional hint that selects among several linked accounts. |

It resolves to the core client's connection token set:

| Field | Description |
| --- | --- |
| `accessToken` | The provider's access token. |
| `expiresAt` | Expiry in epoch seconds. |
| `scope` | The scope granted by the connection, or `undefined`. |
| `connection` | The connection you requested the token for. |
| `loginHint` | The hint passed with the request, if any. |

Pass `loginHint` when the user has more than one linked account for the connection.

## Requirements

- `clientId` and `clientSecret` on `createMcpClient`.
- You enabled the Token Vault grant on that application, and you configured and enabled the federated connection for it.
- The user has linked their external account through Auth0's connected accounts flow. Without a linked account the exchange fails.

For the tenant setup, follow the Auth0 guides:

- [Configure Token Vault](https://auth0.com/docs/secure/tokens/token-vault/configure-token-vault)
- [Connected Accounts for Token Vault](https://auth0.com/docs/secure/tokens/token-vault/connected-accounts-for-token-vault)

## Caching

This package does not cache connection tokens. Each call performs an exchange, so cache the result in your tool if the provider rate-limits you.

## Errors

Errors leave the request-scoped client with a fixed generic message, the original class and `code` of the core error, and the original error as `cause`. See [Errors](./Errors.md).
