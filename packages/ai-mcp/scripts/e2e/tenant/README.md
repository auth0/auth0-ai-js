# Tenant provisioning for the @auth0/ai-mcp end-to-end suite

These scripts build, check and remove the Auth0 tenant objects the real-tenant suite needs. Changing a tenant needs the `auth0` CLI. The commands that never change the tenant are `--dry-run`, `--print-login-command` and the offline `test.sh`.

Run all commands from the `packages/ai-mcp` directory of your checkout.

## Run order

1. Print the login command and run it against the demo tenant: `scripts/e2e/tenant/setup.sh --print-login-command --with-org --with-expiry --with-t2`
2. Read what setup would do: `scripts/e2e/tenant/setup.sh --dry-run --with-org --with-expiry --with-t2`
3. Check the tenant settings and which objects already exist, read only: `scripts/e2e/tenant/setup.sh --check-settings`
4. Build: `scripts/e2e/tenant/setup.sh --yes --with-org --with-expiry --with-t2`. It writes `.env.e2e` (mode 600) in the package directory.
5. Remove everything later: `scripts/e2e/tenant/teardown.sh` (`--list` and `--dry-run` show what it would delete).

Setup is idempotent. A second run prints `exists` for every object and creates nothing. The only call it repeats is an additive update of which clients are enabled on the database connection.

## What it creates

Every name carries the prefix `ai-mcp-e2e`. Identifiers live under `https://<service>.ai-mcp-e2e.test`, except the MCP API, whose identifier is the URL the T2 server listens on (`http://localhost:3011/mcp`, change the port with `--mcp-port`).

| Plan id | Object | Flag | Detail |
| --- | --- | --- | --- |
| A1, A9 | MCP server API | always | `http://localhost:3011/mcp`, RS256, scopes `tool:whoami`, `tool:delegate`, `tool:order_status_report`, `tool:sales_analytics_report` |
| A2 | Work API | always | `https://work.ai-mcp-e2e.test`, scopes `work:read` and `work:write`. `--existing-work-api ID` uses the hand-built `work-api.obo-poc` instead |
| A3 | Orders API | always | `https://orders.ai-mcp-e2e.test`, `read:orders` |
| A4 | Inventory API | always | `https://inventory.ai-mcp-e2e.test`, `read:inventory`, `write:inventory` |
| A5 | Analytics API | always | `https://analytics.ai-mcp-e2e.test`, `read:analytics` (client credentials target) |
| A7 | Ledger API | always | `https://ledger.ai-mcp-e2e.test`, scopes `read:ledger` and `write:ledger`, only `read:ledger` is granted |
| A6 | Short MCP API | `--with-expiry` | `https://short-mcp.ai-mcp-e2e.test`, scope `tool:whoami`, `token_lifetime` from `--lifetime` (default 30) |
| A8 | Short downstream API | `--with-expiry` | `https://short-down.ai-mcp-e2e.test`, scope `read:short`, same lifetime |
| C1 | Exchange client | always | custom API client tied to A1 (`app_type: resource_server`), on-behalf-of profile allowed, `client_credentials` grant type added |
| C1b | Short exchange client | `--with-expiry` | custom API client tied to A6, on-behalf-of profile allowed |
| C2 | Login client | always | non-interactive, password and password-realm grants |
| C3 | Limited client | always | client credentials, grant to A1 with `tool:whoami` only |
| C4 | M2M client | always | client credentials. `--existing-m2m-client ID` uses an existing client and only adds grants |
| C5 | Org tester client | `--with-org` | client credentials, grant to A1 with `organization_usage: allow`, `allow_any_organization: true` |
| C6 | Auth-code client | `--with-org` | regular web app, callback `http://localhost:3015/callback` (`--auth-code-port`), `organization_usage: allow` |
| C7 | Claude Code (CIMD) client | `--with-t2` | external. Setup only reads it and adds a grant to A1. If it is not registered yet, setup warns and skips |
| K1 | Database connection | always | `ai-mcp-e2e-users`, domain-level with `--with-t2`. `--realm NAME` uses an existing connection (checked only unless `--adopt`) |
| U1 | Test user | always | `ai-mcp-e2e-user@example.com` in K1, generated password. `--existing-user` takes the credentials from the environment instead |
| U2 | Org member user | `--with-org` | `ai-mcp-e2e-org-user@example.com`, member of organization A only |
| O1, O2 | Organizations | `--with-org` | `ai-mcp-e2e-org-a`, `ai-mcp-e2e-org-b`, K1 enabled on both |

Grants:

| Client | Audience | Scopes | Subject |
| --- | --- | --- | --- |
| C1 | A2 Work API | `work:read`, `work:write` | user |
| C1 | A3 Orders | `read:orders` | user |
| C1 | A4 Inventory | `read:inventory`, `write:inventory` | user |
| C1 | A5 Analytics | `read:analytics` | client |
| C1 | A7 Ledger | `read:ledger` | user |
| C1b | A8 Short downstream | `read:short` | user |
| C2 | A1 | all four tool scopes | user |
| C2 | A6 | `tool:whoami` | user |
| C3 | A1 | `tool:whoami` | client |
| C4 | A2 | `work:read` | client |
| C4 | A7 | `read:ledger` (partial grant, `write:ledger` is defined but not granted) | client |
| C5 | A1 | `tool:whoami` | client, organization |
| C6 | A1 | all four tool scopes | user |
| C7 | A1 | all four tool scopes | user |

## Env file

Setup writes these names to `.env.e2e`: `AUTH0_E2E_DOMAIN`, `AUTH0_E2E_MCP_AUDIENCE`, `AUTH0_E2E_DOWNSTREAM_AUDIENCE`, `AUTH0_E2E_DOWNSTREAM_SCOPE`, `AUTH0_E2E_OBO_CLIENT_ID`, `AUTH0_E2E_OBO_CLIENT_SECRET`, `AUTH0_E2E_LOGIN_CLIENT_ID`, `AUTH0_E2E_LOGIN_CLIENT_SECRET`, `AUTH0_E2E_USERNAME`, `AUTH0_E2E_PASSWORD`, `AUTH0_E2E_REALM`, `AUTH0_E2E_M2M_CLIENT_ID`, `AUTH0_E2E_M2M_CLIENT_SECRET`, `AUTH0_E2E_ORDERS_AUDIENCE`, `AUTH0_E2E_INVENTORY_AUDIENCE`, `AUTH0_E2E_ANALYTICS_AUDIENCE`, `AUTH0_E2E_LEDGER_AUDIENCE`, `AUTH0_E2E_LIMITED_CLIENT_ID`, `AUTH0_E2E_LIMITED_CLIENT_SECRET`.

With `--with-org`: `AUTH0_E2E_ORG_ID` (same as A), `AUTH0_E2E_ORG_A_ID`, `AUTH0_E2E_ORG_B_ID`, `AUTH0_E2E_ORG_USER_USERNAME`, `AUTH0_E2E_ORG_USER_PASSWORD`, `AUTH0_E2E_AUTHCODE_CLIENT_ID`, `AUTH0_E2E_AUTHCODE_CLIENT_SECRET`, `AUTH0_E2E_AUTHCODE_REDIRECT_PORT`.

With `--with-expiry`: `AUTH0_E2E_SHORT_MCP_AUDIENCE`, `AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE`, `AUTH0_E2E_SHORT_LIFETIME_SECONDS`.

With `--with-t2`: `AUTH0_E2E_T2_PORT`, `AUTH0_E2E_T2_MCP_AUDIENCE`, `AUTH0_E2E_T2_USERNAME`, `AUTH0_E2E_T2_PASSWORD`, and `AUTH0_E2E_CLAUDE_BIN` when `claude` is on the PATH.

Four names are not in the env contract of the plan and are written because the objects need them: `AUTH0_E2E_SHORT_OBO_CLIENT_ID` and `AUTH0_E2E_SHORT_OBO_CLIENT_SECRET` (an exchange client tied to the short MCP API), `AUTH0_E2E_ORG_TESTER_CLIENT_ID` and `AUTH0_E2E_ORG_TESTER_CLIENT_SECRET`. Existing lines in the file that setup does not manage are left alone, and a saved test user password is kept.

## Safety properties

- Look up before create. Each object is found by name or identifier first.
- Only recorded ids are ever modified or deleted. The state file `.env.e2e.state.json` (gitignored through the `.env*` rule, mode 600, ids and names only) is keyed by tenant domain. An object that exists under one of the script's exact names but is not recorded stops the run before any change; `--adopt` takes it over, and teardown then deletes it.
- Objects the script only references (the Claude Code client, `--existing-*`, `--realm` without `--adopt`) are recorded under `refs`. They are never modified or deleted, and teardown removes only the grants setup added for them.
- Teardown re-reads each object before deleting and refuses when the live name differs from the recorded one, or when the recorded id contains unexpected characters.
- Tenant-level settings are only read. Setup, teardown and `--check-settings` never write one.
- Request bodies (which hold the generated passwords) go to the CLI on stdin, never on a command line. Secrets are read into variables and written to the env file only; nothing prints them.
- Client grants whose scopes differ are deleted and created again, so the script never needs `update:client_grants`.

## Auth0 CLI scopes

`setup.sh --print-login-command [flags]` runs the planned flow as a silent dry run, collects the scope every Management API call needs, adds the scopes teardown needs and the two calls that only happen against existing objects, and prints the command. For a full run the list is:

`create:client_grants, create:clients, create:connections, create:organization_connections, create:organization_members, create:organizations, create:resource_servers, create:users, delete:client_grants, delete:clients, delete:connections, delete:organizations, delete:resource_servers, delete:users, read:client_grants, read:client_keys, read:clients, read:connections, read:organization_connections, read:organization_members, read:organizations, read:resource_servers, read:tenant_settings, read:users, update:clients, update:connections, update:resource_servers, update:users`

Before a live run, setup compares this list to the session when `auth0 tenants list --json` reports scopes. The CLI documents no such field, so when none is present setup says so, prints the command and relies on the hint it prints when a call fails with a scope error.

## Tests

`scripts/e2e/tenant/test.sh` runs everything offline against a stub `auth0` binary that keeps a small tenant in a JSON file: login command, dry run (prints each call, invokes no CLI), first run, second run (creates nothing), read-only settings check, refusal of unrecorded objects, teardown (deletes exactly the recorded ids), refusals (name mismatch, malformed id, other tenant), referenced objects, no secret on the terminal, and shellcheck when it is installed.

## Not covered

- The on-behalf-of internal flag cannot be read through the Management API. The runner preflight probes it.
- Real Auth0 behavior of per-grant `subject_type` for user-flow clients (C2, C6) and the minimum accepted `token_lifetime` for the short APIs are unverified until the first live run.
