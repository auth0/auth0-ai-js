/**
 * Environment contract of the real-tenant e2e suite. Values are read from `process.env`;
 * nothing here ever prints a value.
 */

/** Variables every scenario needs. */
const BASE_REQUIRED = [
  "AUTH0_E2E_DOMAIN",
  "AUTH0_E2E_MCP_AUDIENCE",
  "AUTH0_E2E_DOWNSTREAM_AUDIENCE",
  "AUTH0_E2E_OBO_CLIENT_ID",
  "AUTH0_E2E_OBO_CLIENT_SECRET",
  "AUTH0_E2E_LOGIN_CLIENT_ID",
  "AUTH0_E2E_LOGIN_CLIENT_SECRET",
  "AUTH0_E2E_USERNAME",
  "AUTH0_E2E_PASSWORD",
  "AUTH0_E2E_REALM",
] as const;

/** Extra variables only some scenarios need. Pass them to {@link loadE2eEnv}. */
export const M2M_VARS = ["AUTH0_E2E_M2M_CLIENT_ID", "AUTH0_E2E_M2M_CLIENT_SECRET"] as const;
export const ORG_VARS = ["AUTH0_E2E_ORG_ID"] as const;
/** Audiences of the four store services, for the multi-service specs. */
export const MULTI_SERVICE_VARS = [
  "AUTH0_E2E_ORDERS_AUDIENCE",
  "AUTH0_E2E_INVENTORY_AUDIENCE",
  "AUTH0_E2E_ANALYTICS_AUDIENCE",
  "AUTH0_E2E_LEDGER_AUDIENCE",
] as const;
/** Client that is granted only part of the MCP API scopes. */
export const LIMITED_CLIENT_VARS = ["AUTH0_E2E_LIMITED_CLIENT_ID", "AUTH0_E2E_LIMITED_CLIENT_SECRET"] as const;
/** Organization users, the authorization code client and the organization tester client. */
export const ORG_USER_VARS = [
  "AUTH0_E2E_ORG_A_ID",
  "AUTH0_E2E_ORG_B_ID",
  "AUTH0_E2E_ORG_USER_USERNAME",
  "AUTH0_E2E_ORG_USER_PASSWORD",
  "AUTH0_E2E_AUTHCODE_CLIENT_ID",
  "AUTH0_E2E_AUTHCODE_CLIENT_SECRET",
  "AUTH0_E2E_AUTHCODE_REDIRECT_PORT",
  "AUTH0_E2E_ORG_TESTER_CLIENT_ID",
  "AUTH0_E2E_ORG_TESTER_CLIENT_SECRET",
] as const;
/** Short-lived APIs and their exchange client, for the slow expiry scenarios. */
export const SHORT_VARS = [
  "AUTH0_E2E_SHORT_MCP_AUDIENCE",
  "AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE",
  "AUTH0_E2E_SHORT_LIFETIME_SECONDS",
  "AUTH0_E2E_SHORT_OBO_CLIENT_ID",
  "AUTH0_E2E_SHORT_OBO_CLIENT_SECRET",
] as const;

export interface E2eEnv {
  /** Tenant domain, for example `example.us.auth0.com`. */
  domain: string;
  /** Issuer URL, `https://<domain>/`. */
  issuer: string;
  /** Identifier of the MCP API (audience of the user access token). */
  mcpAudience: string;
  /** Identifier of the downstream API the server exchanges for. */
  downstreamAudience: string;
  /** Scope requested for the downstream API. Defaults to `work:read`. */
  downstreamScope: string;
  oboClientId: string;
  oboClientSecret: string;
  loginClientId: string;
  loginClientSecret: string;
  username: string;
  password: string;
  realm: string;
  m2mClientId: string;
  m2mClientSecret: string;
  orgId: string;
  ordersAudience: string;
  inventoryAudience: string;
  analyticsAudience: string;
  ledgerAudience: string;
  limitedClientId: string;
  limitedClientSecret: string;
  /** Organization A and B of the organization scenarios. */
  orgAId: string;
  orgBId: string;
  /** A user who is a member of organization A and signs in through the authorization code flow. */
  orgUserUsername: string;
  orgUserPassword: string;
  authCodeClientId: string;
  authCodeClientSecret: string;
  /** Loopback port the authorization code client allows for its callback. 0 when unset. */
  authCodeRedirectPort: number;
  /** Client credentials client that may mint tokens for either organization. */
  orgTesterClientId: string;
  orgTesterClientSecret: string;
  /** Optional hand-supplied expired access token for the MCP API. */
  expiredToken: string;
  /** Short-lived MCP API (audience of the caller token in the expiry scenarios). */
  shortMcpAudience: string;
  /** Short-lived downstream API the short exchange client exchanges for. */
  shortDownstreamAudience: string;
  /** Token lifetime configured on both short-lived APIs, in seconds. 0 when unset. */
  shortLifetimeSeconds: number;
  /** Exchange client tied to the short-lived MCP API. */
  shortOboClientId: string;
  shortOboClientSecret: string;
}

function read(name: string): string {
  return process.env[name] ?? "";
}

/**
 * Reads the contract. The e2e specs only run through the e2e vitest configs, so a missing
 * required variable is a failure: the error names the missing variables (never values) and fails
 * the spec file loudly.
 *
 * @param extra - Additional required variable names, for example {@link M2M_VARS}.
 */
export function loadE2eEnv(extra: readonly string[] = []): E2eEnv {
  const missing = [...BASE_REQUIRED, ...extra].filter((name) => read(name) === "");
  if (missing.length > 0) {
    throw new Error(`Required e2e settings are missing: ${missing.join(", ")}`);
  }
  const domain = read("AUTH0_E2E_DOMAIN");
  return {
    domain,
    issuer: `https://${domain}/`,
    mcpAudience: read("AUTH0_E2E_MCP_AUDIENCE"),
    downstreamAudience: read("AUTH0_E2E_DOWNSTREAM_AUDIENCE"),
    downstreamScope: read("AUTH0_E2E_DOWNSTREAM_SCOPE") || "work:read",
    oboClientId: read("AUTH0_E2E_OBO_CLIENT_ID"),
    oboClientSecret: read("AUTH0_E2E_OBO_CLIENT_SECRET"),
    loginClientId: read("AUTH0_E2E_LOGIN_CLIENT_ID"),
    loginClientSecret: read("AUTH0_E2E_LOGIN_CLIENT_SECRET"),
    username: read("AUTH0_E2E_USERNAME"),
    password: read("AUTH0_E2E_PASSWORD"),
    realm: read("AUTH0_E2E_REALM"),
    m2mClientId: read("AUTH0_E2E_M2M_CLIENT_ID"),
    m2mClientSecret: read("AUTH0_E2E_M2M_CLIENT_SECRET"),
    orgId: read("AUTH0_E2E_ORG_ID"),
    ordersAudience: read("AUTH0_E2E_ORDERS_AUDIENCE"),
    inventoryAudience: read("AUTH0_E2E_INVENTORY_AUDIENCE"),
    analyticsAudience: read("AUTH0_E2E_ANALYTICS_AUDIENCE"),
    ledgerAudience: read("AUTH0_E2E_LEDGER_AUDIENCE"),
    limitedClientId: read("AUTH0_E2E_LIMITED_CLIENT_ID"),
    limitedClientSecret: read("AUTH0_E2E_LIMITED_CLIENT_SECRET"),
    orgAId: read("AUTH0_E2E_ORG_A_ID"),
    orgBId: read("AUTH0_E2E_ORG_B_ID"),
    orgUserUsername: read("AUTH0_E2E_ORG_USER_USERNAME"),
    orgUserPassword: read("AUTH0_E2E_ORG_USER_PASSWORD"),
    authCodeClientId: read("AUTH0_E2E_AUTHCODE_CLIENT_ID"),
    authCodeClientSecret: read("AUTH0_E2E_AUTHCODE_CLIENT_SECRET"),
    authCodeRedirectPort: Number(read("AUTH0_E2E_AUTHCODE_REDIRECT_PORT")) || 0,
    orgTesterClientId: read("AUTH0_E2E_ORG_TESTER_CLIENT_ID"),
    orgTesterClientSecret: read("AUTH0_E2E_ORG_TESTER_CLIENT_SECRET"),
    expiredToken: read("AUTH0_E2E_EXPIRED_TOKEN"),
    shortMcpAudience: read("AUTH0_E2E_SHORT_MCP_AUDIENCE"),
    shortDownstreamAudience: read("AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE"),
    shortLifetimeSeconds: Number(read("AUTH0_E2E_SHORT_LIFETIME_SECONDS")) || 0,
    shortOboClientId: read("AUTH0_E2E_SHORT_OBO_CLIENT_ID"),
    shortOboClientSecret: read("AUTH0_E2E_SHORT_OBO_CLIENT_SECRET"),
  };
}
