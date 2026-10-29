// Preflight of the real-tenant e2e suite: settings present (names only in messages), discovery
// document reachable, one real login of the test user, one real on-behalf-of exchange.
// It makes token endpoint and discovery requests only and changes nothing in the tenant.
import { classifyError, classifyExchange, classifySignIn } from "./classify.mjs";
import { halfSetGroups, missingRequired } from "./lib.mjs";

const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const DISCOVERY_TIMEOUT_MS = 5000;
const TOKEN_TIMEOUT_MS = 15000;

/**
 * @typedef {object} Step
 * @property {string} name
 * @property {boolean} ok
 * @property {string} line One line, never containing a value from the environment or a token.
 */

/**
 * @typedef {Record<string, string | undefined>} Env
 */

/**
 * Checks that every required setting is present and that no optional group is half set.
 * @param {Env} env
 * @returns {Step}
 */
export function checkSettings(env) {
  const missing = missingRequired(env);
  if (missing.length > 0) {
    return { name: "settings", ok: false, line: `missing required settings: ${missing.join(", ")}` };
  }
  const half = halfSetGroups(env);
  if (half.length > 0) {
    const detail = half.map((h) => `${h.group} (missing ${h.missing.join(", ")})`).join("; ");
    return { name: "settings", ok: false, line: `optional settings groups are only partly set: ${detail}` };
  }
  return { name: "settings", ok: true, line: "all required settings are present" };
}

/**
 * @param {Env} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Step>}
 */
export async function checkDiscovery(env, fetchImpl) {
  const domain = env["AUTH0_E2E_DOMAIN"] ?? "";
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) {
    return { name: "discovery", ok: false, line: "AUTH0_E2E_DOMAIN is not a bare host name (no scheme, no path)" };
  }
  try {
    const response = await fetchImpl(`https://${domain}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return { name: "discovery", ok: false, line: `discovery document answered HTTP ${response.status}` };
    }
    const body = /** @type {{ issuer?: unknown, token_endpoint?: unknown }} */ (await response.json().catch(() => ({})));
    if (body.issuer !== `https://${domain}/`) {
      return { name: "discovery", ok: false, line: "discovery document issuer does not match AUTH0_E2E_DOMAIN" };
    }
    return { name: "discovery", ok: true, line: "discovery document reachable" };
  } catch (error) {
    return { name: "discovery", ok: false, line: classifyError(error).line.replace(/^on-behalf-of exchange: /, "") };
  }
}

/**
 * @param {Env} env
 * @param {typeof fetch} fetchImpl
 * @param {Record<string, string>} form
 */
async function postToken(env, fetchImpl, form) {
  const response = await fetchImpl(`https://${env["AUTH0_E2E_DOMAIN"]}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  return { status: response.status, body: /** @type {unknown} */ (await response.json().catch(() => ({}))) };
}

/**
 * One real password-realm login, then one real exchange of that token for the downstream API.
 * @param {Env} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Step[]>}
 */
export async function checkLoginAndExchange(env, fetchImpl) {
  const scope = env["AUTH0_E2E_DOWNSTREAM_SCOPE"] || "work:read";
  try {
    const login = await postToken(env, fetchImpl, {
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: env["AUTH0_E2E_REALM"] ?? "",
      username: env["AUTH0_E2E_USERNAME"] ?? "",
      password: env["AUTH0_E2E_PASSWORD"] ?? "",
      client_id: env["AUTH0_E2E_LOGIN_CLIENT_ID"] ?? "",
      client_secret: env["AUTH0_E2E_LOGIN_CLIENT_SECRET"] ?? "",
      audience: env["AUTH0_E2E_MCP_AUDIENCE"] ?? "",
      scope,
    });
    const accessToken = /** @type {{ access_token?: unknown }} */ (login.body).access_token;
    if (login.status !== 200 || typeof accessToken !== "string" || accessToken === "") {
      const result = classifySignIn(login);
      return [{ name: "login", ok: false, line: result.line.replace(/^on-behalf-of exchange: /, "") }];
    }
    const steps = /** @type {Step[]} */ ([{ name: "login", ok: true, line: "test user signed in" }]);
    const exchange = await postToken(env, fetchImpl, {
      grant_type: TOKEN_EXCHANGE,
      client_id: env["AUTH0_E2E_OBO_CLIENT_ID"] ?? "",
      client_secret: env["AUTH0_E2E_OBO_CLIENT_SECRET"] ?? "",
      subject_token: accessToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      audience: env["AUTH0_E2E_DOWNSTREAM_AUDIENCE"] ?? "",
      scope,
    });
    const result = classifyExchange(exchange);
    steps.push({ name: "exchange", ok: result.ok, line: result.line });
    return steps;
  } catch (error) {
    return [{ name: "login", ok: false, line: classifyError(error).line }];
  }
}

/**
 * Runs the preflight in order and stops at the first failing step.
 * @param {Env} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, steps: Step[] }>}
 */
export async function runPreflight(env, fetchImpl = fetch) {
  /** @type {Step[]} */
  const steps = [];
  const settings = checkSettings(env);
  steps.push(settings);
  if (!settings.ok) return { ok: false, steps };
  const discovery = await checkDiscovery(env, fetchImpl);
  steps.push(discovery);
  if (!discovery.ok) return { ok: false, steps };
  const rest = await checkLoginAndExchange(env, fetchImpl);
  steps.push(...rest);
  return { ok: steps.every((s) => s.ok), steps };
}
