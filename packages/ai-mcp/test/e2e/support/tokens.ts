/**
 * Token helpers. They call the tenant token endpoint only. Returned tokens are never logged, and
 * failures report the HTTP status and the OAuth `error` code, never a body that could echo input.
 */
import type { E2eEnv } from "./env.js";

export interface TokenEndpointResult {
  status: number;
  /** Parsed JSON body, or an empty object when the body was not JSON. */
  body: Record<string, unknown>;
}

const MAX_ATTEMPTS = 6;
/** Upper bound for one token endpoint request, so a stalled tenant fails the spec instead of hanging it. */
const REQUEST_TIMEOUT_MS = 15_000;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const MIN_DELAY_MS = 250;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Wait in ms from `Retry-After` (seconds or HTTP date) or `x-ratelimit-reset` (epoch seconds), else null. */
function serverDelayMs(headers: Headers, now: number): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-reset") !== null && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - now);
  }
  return null;
}

/** Delay before retry number `attempt` (0-based): the server hint if any, else exponential with jitter. */
export function backoffDelayMs(attempt: number, headers: Headers, now: number = Date.now()): number {
  const hinted = serverDelayMs(headers, now);
  const delay = Math.max(MIN_DELAY_MS, hinted ?? BASE_DELAY_MS * 2 ** attempt * (0.75 + Math.random() * 0.5));
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Posts one form to the token endpoint. Retries 429 and 5xx with bounded exponential backoff,
 * honoring `Retry-After` and `x-ratelimit-reset`. Any other status, including 4xx errors the
 * caller asserts on, is returned as is. Never retries on an assertion; this is transport only.
 */
export async function postTokenRequest(env: E2eEnv, form: Record<string, string>): Promise<TokenEndpointResult> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`https://${env.domain}/oauth/token`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS - 1) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, body };
    }
    await response.arrayBuffer().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(attempt, response.headers)));
  }
}

async function tokenRequest(env: E2eEnv, form: Record<string, string>): Promise<string> {
  const { status, body } = await postTokenRequest(env, form);
  if (status < 200 || status >= 300 || typeof body["access_token"] !== "string") {
    const error = typeof body["error"] === "string" ? body["error"] : "unknown";
    throw new Error(`Token request failed: status ${status}, error ${error}`);
  }
  return body["access_token"];
}

/**
 * Per-process memo of minted tokens, keyed by grant, client, audience, scope and organization.
 * Scenarios share a token unless they pass `fresh: true`. Entries are dropped once within a minute
 * of expiry. The memo is module state, so each vitest worker has its own.
 */
const memo = new Map<string, Promise<string>>();
const EXPIRY_MARGIN_SECONDS = 60;

function expiresSoon(token: string): boolean {
  const exp = decodeClaims(token)["exp"];
  return typeof exp !== "number" || exp - EXPIRY_MARGIN_SECONDS <= Math.floor(Date.now() / 1000);
}

async function memoized(key: string, fresh: boolean | undefined, mint: () => Promise<string>): Promise<string> {
  if (fresh) return mint();
  const hit = memo.get(key);
  if (hit) {
    try {
      const token = await hit;
      if (!expiresSoon(token)) return token;
    } catch {
      // A failed mint is not kept; fall through and mint again.
    }
    if (memo.get(key) === hit) memo.delete(key);
  }
  const pending = mint();
  memo.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (memo.get(key) === pending) memo.delete(key);
    throw error;
  }
}

/** Forgets every memoized token. For tests of the helpers themselves. */
export function clearTokenMemo(): void {
  memo.clear();
}

export interface UserTokenOptions {
  /** Audience of the token. Defaults to the MCP API. */
  audience?: string;
  /** Space-separated scopes. Defaults to the downstream scope. */
  scope?: string;
  /** Skip the per-process memo and mint a new token. */
  fresh?: boolean;
}

/** Password-realm grant for the test user through the login client. Returns the access token. */
export function getUserToken(env: E2eEnv, options: UserTokenOptions = {}): Promise<string> {
  const audience = options.audience ?? env.mcpAudience;
  const scope = options.scope ?? env.downstreamScope;
  const key = JSON.stringify(["password-realm", env.loginClientId, env.username, audience, scope]);
  return memoized(key, options.fresh, () =>
    tokenRequest(env, {
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: env.realm,
      username: env.username,
      password: env.password,
      client_id: env.loginClientId,
      client_secret: env.loginClientSecret,
      audience,
      scope,
    }),
  );
}

export interface ClientCredentialsOptions {
  audience: string;
  scope?: string;
  /** Organization id; the token then carries `org_id`. */
  organization?: string;
  /** Which client authenticates. Defaults to the M2M client. */
  clientId?: string;
  clientSecret?: string;
  /** Skip the per-process memo and mint a new token. */
  fresh?: boolean;
}

/** Client credentials grant. Defaults to the M2M client of the contract. */
export function getClientCredentialsToken(env: E2eEnv, options: ClientCredentialsOptions): Promise<string> {
  const clientId = options.clientId ?? env.m2mClientId;
  const key = JSON.stringify(["client_credentials", clientId, options.audience, options.scope ?? null, options.organization ?? null]);
  return memoized(key, options.fresh, () =>
    tokenRequest(env, {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: options.clientSecret ?? env.m2mClientSecret,
      audience: options.audience,
      ...(options.scope !== undefined && { scope: options.scope }),
      ...(options.organization !== undefined && { organization: options.organization }),
    }),
  );
}

/** Decodes the payload of a JWT without verifying it. For assertions on claim names only. */
export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}
