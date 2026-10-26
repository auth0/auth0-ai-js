# Organization policy

Auth0 Organizations let you model the business customers of a multi-tenant application. A token issued in an organization context carries an `org_id` claim. The organization policy decides what your MCP server does with it.

`createMcpClient` accepts two options:

| Option | Description |
| --- | --- |
| `organizationPolicy` | `'allow'` (default) performs no organization check. `'required'` rejects tokens that carry no `org_id` claim. |
| `organizationId` | One organization id or a list of ids. With `'required'`, the token's `org_id` must be in the list. |

`organizationId` takes `org_...` identifiers, not organization names, and the check compares entries exactly, so trim values that come from a delimited source such as an environment variable.

## Accepting any organization

```ts
import { createMcpClient } from '@auth0/ai-mcp';

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  organizationPolicy: 'required',
});
```

Every request must come from a token issued in some organization context. Read the organization in tool code from `principal.orgId`.

## Restricting to specific organizations

```ts
import { createMcpClient } from '@auth0/ai-mcp';

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  organizationPolicy: 'required',
  organizationId: ['org_abc123', 'org_def456'],
});
```

Setting `organizationId` with any policy other than `'required'`, including the default, makes `createMcpClient` throw `InvalidConfigurationError`, so a restriction is never silently ignored. The same error is thrown for an invalid policy value or an unusable allowlist.

## Failures

The client enforces the policy during token verification, before any tool runs. The handler answers a rejected token with HTTP 401 and `error="invalid_token"`, because RFC 6750 defines no organization-specific error value. Server-side code can tell the two cases apart:

| Case | Error class from `@auth0/auth0-api-js` | `code` |
| --- | --- | --- |
| No `org_id` claim | `MissingOrganizationError` | `missing_organization` |
| `org_id` not in the allowlist | `OrganizationNotAllowedError` | `organization_not_allowed` |

Both extend `VerifyAccessTokenError`. Their messages never include the rejected organization id.

The client validates the policy when you create it. Changing the options object afterwards has no effect.

Pass `apiClient` when you need to configure the policy on a core client yourself. Combining `apiClient` with `organizationPolicy` or `organizationId` throws `InvalidConfigurationError`, so configure them on the client you pass in.
