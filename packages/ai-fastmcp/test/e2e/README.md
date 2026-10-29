# Real-tenant end-to-end tests

These specs use no mocks. A real FastMCP server listens on a local port with `createFastMcpAuth` in front of it. A real
`@modelcontextprotocol/client` connects over Streamable HTTP with an access token the Auth0 tenant issued. The adapter
verifies that token against the tenant's keys, the tools exchange it on behalf of the caller at the tenant's token
endpoint, and a local downstream API verifies the exchanged token against the same keys and reports its claims.

## How the suite is kept apart from the unit tests

The real-tenant specs end in `.e2e.spec.ts` (fast tier) or `.e2e.slow.spec.ts` (slow tier). The default
`vitest.config.ts` excludes both patterns, so `npm test` never runs them. They run only through `vitest.e2e.config.ts`
and `vitest.e2e.slow.config.ts`, which `npm run e2e` and `npm run test:e2e` use. No CI workflow runs them. A spec file
whose required settings are missing does not run: vitest skips it, and the title names the missing variables, never their values.

`support/support.spec.ts` checks the helpers and the runner without a tenant and runs with the normal unit suite.

## Running

Copy `.env.e2e.example` to `.env.e2e` and fill it in, or export the variables. The runner takes the first of these that
exists: the file named by `AUTH0_E2E_ENV_FILE`, `packages/ai-fastmcp/.env.e2e`, then `packages/ai-mcp/.env.e2e`. The two
packages share one tenant and one set of variable names, so one file serves both. Real environment variables win over
the file.

`npm run e2e` runs the fast tier. To pass options, call the runner directly with `node scripts/e2e/run.mjs <options>`
(npm also forwards options that follow its own argument separator).

- `--slow` runs only the slow tier, which waits for real tokens to expire (about two minutes).
- `--all` runs both tiers, fast first.
- `--check` runs only the preflight: settings present, discovery reachable, the local port free, one real sign in, one
  real exchange.
- `--only obo --only scopes` runs the files whose names contain those fragments, and bare words work too.
  `--verbose` streams the full test output.
- `npm run test:e2e` calls vitest on the fast config directly and reads only the environment.

The runner writes `e2e-report.md` (ignored by git) with one row per scenario id, the version of `fastmcp` that was
installed, and the settings groups that were not provided. The runner strips secret values and anything shaped like a JWT
from the output. A run in which nothing passed counts as a failure.

Files run one at a time. The MCP API identifier of the tenant is a loopback URL with a fixed port, and the server under
test listens on that port, so two servers cannot run together. Every spec starts and stops its own server.

## Scenarios

Each test title starts with its scenario id. Most scenarios run against both a stateless and a stateful server. E-N-01
needs a stateful one, and E-C-01 uses a stateless one.

| Id | Spec | What it proves |
| --- | --- | --- |
| E-A-01 | `authentication` | A user token and a client credentials token reach a tool, and `session.principal` has the right subject, client and scopes. A token for another audience gets a 401. |
| E-A-02 | `authentication` | Missing, malformed, tampered, forged and oversized bearer values get a 401 or 400 without leaking library text or the value. |
| E-B-01 | `obo` | The exchanged token reaches the downstream API with the caller as subject and the exchange client as actor. A second call comes from the store. |
| E-B-02 | `obo` | A tenant refusal and an error with a secret in its message reach the client as fixed text. |
| E-B-03 | `obo` | Ten concurrent identical calls make one exchange, with and without a store. |
| E-C-01 | `configuration` | The client, inline, env and partial tiers publish the same metadata and exchange for a real user. |
| E-D-01 | `metadata` | The challenge's metadata URL, fetched from the running server, returns the document with the right resource and tenant. The MCP SDK's discovery helpers follow it to the tenant's authorization server metadata. |
| E-F-01 | `faults` | A key or discovery outage answers 401 with fixed text and recovers on the next call. |
| E-I-01 | `isolation` | Four distinct callers at once never see each other, and the store keeps each exchange under its own caller. |
| E-I-02 | `isolation` | The session, the accessors and the bound client agree on the caller under concurrency. |
| E-N-01 | `session-binding` | A second real user on the first user's session id gets 403. |
| E-P-01 | `dpop` | A DPoP header, the DPoP scheme or a key-bound token gets a Bearer challenge before any tenant call. |
| E-S-01 | `scopes` | The server-wide gate answers 403, the tool wrapper names the missing scope, and `canAccess` hides a tool. |
| E-X-01 | `slow/expiry` | A caller token that expires inside a stateful session, or on a stateless server, gets a 401. |
| E-X-02 | `slow/expiry` | A cached exchanged token past its expiry gives way to a new exchange. |

### Not covered

A real DPoP-bound access token. The suite asks the tenant for one with a real proof on each run and skips the scenario,
with the reason, when the tenant answers with an ordinary Bearer token. That is what it does today, so only the
fail-closed paths run live.

## Pinned behavior

Titles that contain `pinned-tenant` or `pinned behavior` record what the tenant or a dependency does today.
When one fails, look at the dependency before suspecting the adapter.

- A client that is not allowed to exchange for a user, an audience the tenant does not know and a wrong exchange
  client secret all surface as the fixed text `Tool execution failed.`.
- A bearer value with no token, or with two words, is a malformed request (400 `invalid_request`). Any other scheme counts
  as no credential (401, no error code).
- A key or discovery outage gets 401 `invalid_token`, because the core client reports every verification
  failure as an invalid token.

## Tenant requirements

The suite reuses the objects the `@auth0/ai-mcp` suite uses and creates nothing. It makes no Management API calls.

- The MCP API, whose identifier is a loopback URL `http://127.0.0.1:<port>/mcp` with scopes `tool:whoami` and
  `tool:delegate`, and the downstream API with scope `work:read`.
- The exchange client (a custom API client allowed to use the on-behalf-of profile) and the login client (password
  realm).
- Two users who both sign in through that realm, a client credentials client holding `tool:whoami` only, and a second
  client credentials client with a grant on the MCP API.
- For the slow tier, a short-lived MCP API and downstream API with a configured token lifetime.

## Environment

See `.env.e2e.example` for the full list. Required for every scenario: `AUTH0_E2E_DOMAIN`, `AUTH0_E2E_MCP_AUDIENCE`,
`AUTH0_E2E_DOWNSTREAM_AUDIENCE`, `AUTH0_E2E_OBO_CLIENT_ID` and `_SECRET`, `AUTH0_E2E_LOGIN_CLIENT_ID` and `_SECRET`,
`AUTH0_E2E_USERNAME`, `AUTH0_E2E_PASSWORD` and `AUTH0_E2E_REALM`. Optional groups: the second user
(`AUTH0_E2E_ORG_USER_*`), the limited client (`AUTH0_E2E_LIMITED_CLIENT_*`), the second client
(`AUTH0_E2E_ORG_TESTER_CLIENT_*`) and the slow tier (`AUTH0_E2E_SHORT_*`). A group that is half set fails the
preflight.

## Support API (`test/e2e/support`)

- `readE2eSettings(extra?)` and `describeLive(name, extra, fn)`: read the contract without throwing, and skip a suite
  when it is incomplete.
- `firstUser`, `secondUser`, `limitedClient`, `testerClient`: callers with a `token()` method, memoized per process.
- `startFastMcpServer({ env, downstreamUrl, stateless?, configuration?, endpoint?, auth?, clientOptions? })`: starts the
  server and returns `{ url, origin, port, audience, client, errors, logs, stop() }`. `configuration` selects the tier.
  Tools: `whoami`, `whoami_raw`, `delegate`, `delegate_via_accessor`, `needs_delegate`, `needs_never`,
  `hidden_without_delegate`, `throws_canary`, `user_error`.
- `startDownstreamApi({ domain, audience })`: the local verifier; `{ url, calls, close }`.
- `connect(server, token?, headers?)`, `callTool`, `listToolNames`, `postInitialize`, `callOnSession`, `rawRequest`: the
  real MCP client and raw HTTP probes. Requests ask for a connection of their own, because several servers run in turn
  on one port.
- `installFetchCounter()`: counts token endpoint POSTs by grant type and lists every request.
  `installFetchFault(match, fault, { times? })`: makes matching requests fail or stall.
- `signedByAttacker`, `withTamperedPayload`, `withAlgNone`, `headerOnly`, `withForeignSignature`: hostile bearer values
  built from a real token.
- `expectNoTokens`, `expectNoSecrets`: fail without printing the value when a place holds a token fragment or a secret.
- `buildDpopProof`, `requestDpopBoundUserToken`: DPoP proofs, and the attempt to obtain a bound token.
