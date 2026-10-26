# MCP clients and tenant settings

This package verifies the access token on each request and publishes the protected resource metadata document. It does not register MCP clients, and it cannot change your tenant. A real MCP client signs in through your Auth0 tenant, so the tenant has to accept that client. For Claude Code, two tenant settings must be set once per tenant, and the person who administers the tenant has to set them.

## How Claude Code identifies itself

Claude Code identifies itself with a client ID metadata document URL, `https://claude.ai/oauth/claude-code-client-metadata`, instead of a client ID issued by your tenant. Your tenant has to accept that kind of client before sign-in can work.

## Tenant settings

Both settings are under Settings, Advanced in the Auth0 Dashboard.

| Setting | Required value | Why |
| --- | --- | --- |
| Client ID Metadata Document Registration | On | Without it the tenant does not recognize the client and sign-in fails with `Unknown client`. |
| Resource Parameter Compatibility Profile | `compatibility` | Claude Code sends the RFC 8707 `resource` parameter to say which server it wants a token for. Auth0 only honors that parameter in the compatibility profile. With the default value, `audience`, Auth0 ignores the parameter and sign-in fails with `userinfo audience is not allowed for this client`. |

The compatibility profile is a tenant setting, so it is not limited to this server. Test your other applications after you change it, and use a development tenant first.

## What a client ID metadata document client means for your tenant

Auth0 treats a client registered this way as a third-party client. Its client ID starts with `tpc_`. That has these consequences:

- It can sign users in only through domain-level connections. Making a connection domain-level makes it available to every client on the tenant.
- It needs a client grant to your MCP API that lists the tool scopes, with `subject_type` set to `user`.
- Users may see a consent screen.

[The example README](https://github.com/auth0/auth0-ai-js/tree/main/examples/ai-mcp-server#set-up-your-tenant) has the commands for each step.

## Check your tenant

In the Dashboard, open Settings, then Advanced, and read both values. With the [Auth0 CLI](https://github.com/auth0/auth0-cli), this read-only call returns the tenant settings:

```bash
auth0 api get tenants/settings
```

Look at these two fields in the response:

- `client_id_metadata_document_supported` must be `true`.
- `resource_parameter_profile` must be `compatibility`.

Do not write these settings from your server. The SDK does not read or change them.

## Sign-in errors

| What you see | Cause | Fix |
| --- | --- | --- |
| `Unknown client` at sign-in | Client ID Metadata Document Registration is off, or the client URL is not registered with the tenant. | Turn the setting on, then register the client. |
| `userinfo audience is not allowed for this client` | Resource Parameter Compatibility Profile is still `audience`. | Set it to `compatibility`. |
| `not authorized to access resource server` | The client has no client grant for your MCP API. | Create the grant with the tool scopes and `subject_type` `user`. |
| `MCP endpoint not found` | The URL you gave the client does not end in `/mcp`. | Use the full MCP URL. |
| Sign-in works but every call returns 401 | The audience your server checks differs from the API identifier in Auth0. | Make `audience` match the API identifier exactly. |

## Other clients

We tested only Claude Code against the example. We did not test MCP Inspector, Claude Desktop or ChatGPT, and their registration requirements may differ.
