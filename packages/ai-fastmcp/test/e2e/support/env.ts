/**
 * Environment contract of the real-tenant e2e suite. The names are the ones the `@auth0/ai-mcp`
 * e2e suite uses, so one settings file serves both packages. Values are read from `process.env`;
 * nothing here ever prints a value.
 */

/** Variables every scenario needs. */
export const BASE_VARS = [
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

/** A second real user, who signs in through the same password realm. */
export const SECOND_USER_VARS = ["AUTH0_E2E_ORG_USER_USERNAME", "AUTH0_E2E_ORG_USER_PASSWORD"] as const;
/** A client credentials client that is granted only part of the MCP API scopes. */
export const LIMITED_CLIENT_VARS = ["AUTH0_E2E_LIMITED_CLIENT_ID", "AUTH0_E2E_LIMITED_CLIENT_SECRET"] as const;
/** A second client credentials client with a grant on the MCP API. */
export const TESTER_CLIENT_VARS = ["AUTH0_E2E_ORG_TESTER_CLIENT_ID", "AUTH0_E2E_ORG_TESTER_CLIENT_SECRET"] as const;
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
  /** Identifier of the MCP API: the audience of the caller tokens and the resource the server publishes. */
  mcpAudience: string;
  /** Identifier of the downstream API the server exchanges for. */
  downstreamAudience: string;
  /** Scope requested for the downstream API. Defaults to `work:read`. */
  downstreamScope: string;
  /** The client that performs the exchange and is the OAuth client of the server. */
  oboClientId: string;
  oboClientSecret: string;
  /** The client that mints the user tokens. */
  loginClientId: string;
  loginClientSecret: string;
  username: string;
  password: string;
  realm: string;
  secondUsername: string;
  secondPassword: string;
  limitedClientId: string;
  limitedClientSecret: string;
  testerClientId: string;
  testerClientSecret: string;
  shortMcpAudience: string;
  shortDownstreamAudience: string;
  /** Token lifetime configured on both short-lived APIs, in seconds. 0 when unset. */
  shortLifetimeSeconds: number;
  shortOboClientId: string;
  shortOboClientSecret: string;
}

export type E2eSettings =
  | { ready: true; missing: []; env: E2eEnv }
  | { ready: false; missing: string[]; env: E2eEnv };

function read(name: string): string {
  return process.env[name] ?? "";
}

/**
 * The names in `names` that are empty or unset.
 */
export function missingVars(names: readonly string[]): string[] {
  return names.filter((name) => read(name) === "");
}

function build(): E2eEnv {
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
    secondUsername: read("AUTH0_E2E_ORG_USER_USERNAME"),
    secondPassword: read("AUTH0_E2E_ORG_USER_PASSWORD"),
    limitedClientId: read("AUTH0_E2E_LIMITED_CLIENT_ID"),
    limitedClientSecret: read("AUTH0_E2E_LIMITED_CLIENT_SECRET"),
    testerClientId: read("AUTH0_E2E_ORG_TESTER_CLIENT_ID"),
    testerClientSecret: read("AUTH0_E2E_ORG_TESTER_CLIENT_SECRET"),
    shortMcpAudience: read("AUTH0_E2E_SHORT_MCP_AUDIENCE"),
    shortDownstreamAudience: read("AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE"),
    shortLifetimeSeconds: Number(read("AUTH0_E2E_SHORT_LIFETIME_SECONDS")) || 0,
    shortOboClientId: read("AUTH0_E2E_SHORT_OBO_CLIENT_ID"),
    shortOboClientSecret: read("AUTH0_E2E_SHORT_OBO_CLIENT_SECRET"),
  };
}

/**
 * Reads the contract without throwing. `ready` is false, and `missing` names the variables (never
 * values), when a base variable or one of `extra` is empty. The specs skip in that case, so the
 * suite stays quiet when it has no tenant to talk to. The runner's preflight is what turns missing
 * required settings into a failure.
 *
 * @param extra - Further required variable names, for example {@link SHORT_VARS}.
 */
export function readE2eSettings(extra: readonly string[] = []): E2eSettings {
  const missing = missingVars([...BASE_VARS, ...extra]);
  const env = build();
  return missing.length === 0 ? { ready: true, missing: [], env } : { ready: false, missing, env };
}
