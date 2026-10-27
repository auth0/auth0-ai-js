# Real-tenant end-to-end tests

These specs use no mocks. A real user access token (password-realm grant) goes through a real
`@modelcontextprotocol/sdk` client and `StreamableHTTPClientTransport` over HTTP on localhost into
the real `@auth0/ai-mcp` handler, which performs a real token exchange against an Auth0 tenant. A local
downstream API verifies the forwarded bearer against the tenant JWKS (issuer, audience and RS256
checked) and reports the verified claims.

## How the suite is kept apart from the unit tests

The real-tenant specs end in `.e2e.spec.ts` (fast tier) or `.e2e.slow.spec.ts` (slow tier). The default
`vitest.config.ts` excludes both patterns, so `npm test` never runs them. They run only through
`vitest.e2e.config.ts` and `vitest.e2e.slow.config.ts`, which `npm run e2e` and `npm run test:e2e`
use. There is no extra enable flag. When a required setting is missing, the spec file fails and names the
missing variables (never their values). No CI workflow runs them.

## Running

Copy `.env.e2e.example` to `.env.e2e` and fill it in, or export the variables listed below, then:

- `npm run e2e` runs the fast tier: every spec file except the slow ones.
- `npm run e2e -- --slow` runs only the slow tier.
- `npm run e2e -- --all` runs both tiers, fast first.
- `npm run e2e -- --check` runs only the preflight and stops.
- `npm run e2e -- --only m2m --only obo-cache` runs the files whose names contain those fragments.
- `npm run e2e -- --setup` runs the tenant setup script first. `--verbose` streams the full test output.
- `npm run test:e2e` calls vitest on the fast config directly and reads only the environment, not `.env.e2e`.

The runner (`scripts/e2e/run.mjs`) loads `.env.e2e` (real environment variables win), runs a
preflight (required names, discovery reachable, one real login, one real token exchange), then vitest.
It prints a short summary and writes `e2e-report.md` (gitignored) with a row per scenario id and the
list of settings groups that were not provided. Files run one at a time (`fileParallelism: false`)
so they do not hit the tenant token endpoint at once.

### Reading the result

A green run means every scenario in the selected tier passed against the live tenant. The summary line
reports passed, failed and skipped counts, and `skipped groups` lists optional settings groups that were
left empty. A group that is half set is reported by the preflight and fails the run. Scenarios whose titles
contain `pinned-tenant` record how the tenant behaves today (for example a refusal the tenant issues). When
one of those fails, re-observe the tenant before suspecting the library. A red run prints the tail of the
test output; use `--verbose` for all of it. Secret values are redacted from the output.

### Slow tier

The slow tier (`vitest.e2e.slow.config.ts`, files ending in `.e2e.slow.spec.ts`) waits for real access
tokens to expire, so each file takes minutes. It uses two short-lived APIs and an exchange client created by the
tenant setup script, configured through the `AUTH0_E2E_SHORT_*` variables. Without them the spec fails and
names the missing variables. `slow/expiry.e2e.slow.spec.ts` covers three cases: a caller token accepted before
its expiry and rejected after it, a cached exchanged token replaced after its expiry, and a cached token
inside the leeway window not being served.

## Spec files added for broader coverage

- `multi-service.e2e.spec.ts`: four local verifying services (Orders, Inventory, Analytics, Ledger), each
  checking its own audience against the tenant keys. It covers one tool call reaching several services, a token for one
  service refused by another, cache hits, ten concurrent calls exchanging once, the refusal of a user exchange for a
  machine-only API, and caller grants: a client that lacks a tool scope, and scopes defined on an API but missing from the
  exchange client grant. Needs the `AUTH0_E2E_*_AUDIENCE` service variables and the limited client.
- `org-user.e2e.spec.ts`: users who sign in through an organization with the authorization code flow, driven by a
  scripted login. It covers an allow-list accepting organization A, rejecting organization B, and a required policy
  rejecting a user with no organization. Needs the organization variables.
- `discovery.e2e.spec.ts`: a 401 leads through the protected resource metadata to the authorization server and its signing
  keys. The authorize check that uses only the MCP URL as `resource` runs when the organization group is set.
- `slow/expiry.e2e.slow.spec.ts`: described under the slow tier.

### Organization usage prerequisite

A positive organization hop, where the server exchanges an organization-bound user token for a downstream
token, needs the exchange client to be allowed to use organizations. The setup script does not grant this, so the
pinned-tenant test in `org-user.e2e.spec.ts` documents the refusal the tenant returns today. After the tenant owner
allows organization usage for the exchange client, that test fails on purpose and should be replaced by a test of the
positive hop.

## Pinned tenant behaviour

The specs that pin exact tenant status or error codes (`scope-probe`, `obo-errors`, `token-vault`)
document how the tenant behaves today. A failure there means re-observe the tenant first; it is not
necessarily a library regression.

`client-prerequisites` checks two tenant settings that only real third-party MCP clients such as
Claude Code need: Client ID Metadata Document registration on, and Resource Parameter Compatibility
Profile set to `compatibility` (both under Settings > Advanced in the Auth0 Dashboard). The other
specs use the password-realm flow and do not depend on them, so a failure there is a tenant setup
problem, not an SDK regression. See [MCP client prerequisites](../../docs/McpClients.md).

## Rate limits

The tenant rate limits the password-realm and client credentials grants (429). Token helpers in
`support/tokens.ts` retry 429 and 5xx with bounded exponential backoff, honoring `Retry-After` and
`x-ratelimit-reset`, through one function, `postTokenRequest`. Minted user and client credentials
tokens are memoized per process by grant, client, audience, scope and organization; pass
`fresh: true` to mint a new one. Mint tokens in `beforeAll`, outside any fetch counter window, so
retries never move a count assertion.

## Environment

See `.env.e2e.example` for the full list. Required for every scenario: `AUTH0_E2E_DOMAIN`,
`AUTH0_E2E_MCP_AUDIENCE`, `AUTH0_E2E_DOWNSTREAM_AUDIENCE`, `AUTH0_E2E_OBO_CLIENT_ID` and `_SECRET`
(the client that performs the exchange), `AUTH0_E2E_LOGIN_CLIENT_ID` and `_SECRET` (the client that
mints the user token), `AUTH0_E2E_USERNAME`, `AUTH0_E2E_PASSWORD`, `AUTH0_E2E_REALM`.
Optional: `AUTH0_E2E_DOWNSTREAM_SCOPE` (default `work:read`), `AUTH0_E2E_M2M_CLIENT_ID` and `_SECRET`
and `AUTH0_E2E_ORG_ID` (scenarios that opt in with `M2M_VARS` / `ORG_VARS`), `AUTH0_E2E_EXPIRED_TOKEN`
(an already expired token for the MCP API; the expiry spec is skipped without it).

By default the tests only call the token endpoint and the JWKS and discovery documents. They make no
Management API calls and change nothing in the tenant.

The one exception is `client-prerequisites.e2e.spec.ts`, which is opt-in. Only when
either `AUTH0_E2E_MGMT_TOKEN` or both `AUTH0_E2E_MGMT_CLIENT_ID` and `AUTH0_E2E_MGMT_CLIENT_SECRET` are
set (together with `AUTH0_E2E_DOMAIN`) it makes read-only `GET` calls to the Management API to read
the tenant settings. With none of those variables it is skipped. With only some of them set (for example a client id without a secret) it fails and names the missing variables. The helper
(`support/tenant-settings.ts`) throws on any method other than `GET` before a request is made. With
the client id and secret pair, the spec first gets a Management API token from the token endpoint.
The credential needs permission to read tenant settings.

## Support API (`test/e2e/support`)

- `loadE2eEnv(extra?)`: reads the contract; throws naming the missing variables.
- `getUserToken(env, { audience?, scope?, fresh? })`: password-realm access token for the test user (memoized).
- `getClientCredentialsToken(env, { audience, scope?, organization?, clientId?, clientSecret?, fresh? })` (memoized).
- `postTokenRequest(env, form)`: raw token endpoint POST with retry; returns `{ status, body }`.
- `decodeClaims(token)`: unverified payload, for claim-name assertions only.
- `startDownstreamApi({ domain, audience })`: local verifier; `{ url, calls, close }`.
- `startMcpServer({ env, downstreamUrl, scopeMatching?, tokenStore?, requiredScopes?, organizationPolicy?, organizationId?, audience?, clientSecret?, dpop?, registerTools? })`: Node adapter (`createNodeMcpHandler`). Returns `{ url, htu, client, close }`. Tools: `whoami`, `delegate({ scope?, audience? })`, `service({ connection, loginHint? })` (Token Vault, returns `{ ok, hasToken, scopeGranted }`, never a token).
  - No `tokenStore` (or `tokenStore: null`) means no store: nothing is cached and only single-flight applies.
  - `clientSecret` overrides the exchange client secret. `dpop` is passed to the ingress client (`{ mode: "allowed" | "required" | "disabled" }`, default `allowed`).
  - `htu` is the URL the handler sees for the MCP endpoint (`<resource origin>/mcp`, the Node adapter and the bridge below rebuild requests on the resource origin). Use it as the `htu` of DPoP proofs.
- `startWebMcpServer(sameOptions)`: serves the web-standard `createMcpSdkHandler` through a thin bridge (message conversion only). Returns the same fields plus `handle(request)` (call the handler directly) and `metadataUrl` (local URL of the protected resource metadata route).
- `connectMcpClient(url, accessToken?)` and `callToolJson(client, name, args?)`: real SDK client.
- `postInitialize(url, authorization?)`: raw POST returning status and parsed `WWW-Authenticate`.
- `installFetchCounter()`: counts `/oauth/token` POSTs by grant type; call `restore()` in `afterEach`.
- `installFetchFault(match, fault, { times? })`: `match` is `{ urlIncludes?, method?, grantType?, predicate? }`; `fault` is `{ kind: "status", status, body?, headers? }`, `{ kind: "network", message? }` (rejects with `TypeError("fetch failed")`) or `{ kind: "delay", ms }` (then passes through). Returns `{ injected, restore() }`. `times` faults the first N matches, then passes through.
- `generateDpopKeyPair()` and `buildDpopProof(keys, { htm, htu, accessToken?, nonce?, iat?, jti? })`: ES256 key generated at runtime and an RFC 9449 proof JWT (`ath` is set when `accessToken` is given). `keys.jkt` is the thumbprint for `cnf.jkt`.
- `describeRequest(input, init)`: URL, method and grant type of a fetch call.

### Fetch seams: what the global `fetch` wrappers can reach

`createMcpClient` accepts no custom fetch, so `globalThis.fetch` is the only seam. Verified against the installed core (`@auth0/auth0-api-js`) and `jose`:

- Token endpoint calls (exchange, client credentials, Token Vault) call the global `fetch` on every request. Faultable at any time.
- OIDC discovery (`oauth4webapi` `discoveryRequest`) uses the global `fetch` at call time, but the metadata is cached per client after the first success.
- JWKS (`jose` `createRemoteJWKSet`) goes through the global `fetch`, but the core binds the `fetch` it sees when the JWKS set is first created (first token verification per client and JWKS URI), and caches the set. A fault installed after that point is not seen.
- So for JWKS and discovery faults: install the fault, then create a fresh server (new client), then send the first authenticated request. A failed fetch is not cached; the next request retries and succeeds.
- Observed (live): a 503 on the JWKS or the discovery GET makes ingress answer 401 with a Bearer challenge, not 500, because the core reports any verification failure as `VerifyAccessTokenError`. The retry after the fault is served normally.

### Install order of `installFetchCounter` and `installFetchFault`

The later install is the outer wrapper. Install the fault first and the counter second to count every attempt including faulted ones (a faulted exchange then shows in `counter.exchanges`). Install the counter first and the fault second to count only requests that reach the network. Restore in reverse order of installation.
