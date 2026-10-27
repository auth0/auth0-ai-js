// Turns the answer of one token endpoint request into a single plain-language line.
// Pure functions, no network. The wording avoids blaming the tenant unless the answer proves it.
//
// Auth0 answers seen in practice:
//   tenant feature off     400, description names a "Custom API Client" or resource_server_id
//   not allowed            description says token exchange or the grant type is not allowed or unsupported
//   wrong client secret    401, or invalid_client
//   undefined audience     400 invalid_target
//   client not granted     403 access_denied or unauthorized_client, or invalid_scope

export const PREFIX = "on-behalf-of exchange: ";

// Only this wording means the tenant feature is off (the exchange client is not a Custom API Client).
const NOT_ENABLED_TEXT = /custom api client|resource_server_id/i;

// Other "not allowed" answers can come from the client's grant types or from the tenant.
const NOT_ALLOWED_TEXT =
  /token[ -]exchange[^.]*(not (allowed|enabled|supported|available)|disabled|unsupported)|(not (allowed|supported|enabled)|unsupported)[^.]*(grant type|token[ -]exchange)|grant type[^.]*(not (allowed|supported|enabled)|unsupported)/i;

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * @typedef {{ code: string, ok: boolean, line: string }} Classification
 */

/**
 * Classifies the answer of the token exchange request.
 * @param {{ status: number, body: unknown } | undefined} response HTTP status and parsed JSON body (any shape).
 * @returns {Classification}
 */
export function classifyExchange(response) {
  const status = Number(response?.status) || 0;
  /** @type {Record<string, unknown>} */
  const body =
    response && typeof response.body === "object" && response.body !== null
      ? /** @type {Record<string, unknown>} */ (response.body)
      : {};
  const error = text(body["error"]).toLowerCase();
  const description = text(body["error_description"]);
  /** @param {string} code @param {string} line @returns {Classification} */
  const result = (code, line) => ({ code, ok: code === "enabled", line: PREFIX + line });

  if (status >= 200 && status < 300 && typeof body["access_token"] === "string" && body["access_token"] !== "") {
    return result("enabled", "enabled");
  }
  if (NOT_ENABLED_TEXT.test(description)) {
    return result("not_enabled", "NOT enabled on this tenant (the exchange client is not a Custom API Client). Ask the tenant owner to turn it on.");
  }
  if (error === "unsupported_grant_type" || NOT_ALLOWED_TEXT.test(description)) {
    return result(
      "not_allowed",
      "not allowed for this client or tenant (client grant type or tenant feature). Check the exchange client's grant types.",
    );
  }
  if (status === 401 || error === "invalid_client") {
    return result(
      "bad_secret",
      "the exchange client's secret was rejected (HTTP 401). AUTH0_E2E_OBO_CLIENT_SECRET does not match the tenant, for example because the client was recreated or the secret rotated.",
    );
  }
  if (error === "invalid_target" || (status === 400 && /audience|resource server|api .*not found/i.test(description))) {
    return result(
      "unknown_audience",
      "the downstream API does not exist in this tenant (Auth0 says the audience is unknown). Check AUTH0_E2E_DOWNSTREAM_AUDIENCE or run the tenant setup.",
    );
  }
  if (status === 403 || error === "unauthorized_client" || error === "access_denied" || error === "invalid_scope") {
    return result(
      "missing_grant",
      "the exchange client has no permission to call the downstream API for a user (missing client grant or scope).",
    );
  }
  const code = error || "no error code";
  return result(
    "other",
    `failed for another reason (HTTP ${status || "unknown"}, ${code.replace(/[^a-z0-9_ ]/g, "").slice(0, 40)}). Not a known cause.`,
  );
}

/**
 * Line for a failed sign-in of the test user, which happens before the exchange.
 * `code` is signin_stale_password for invalid_grant (the saved password no longer matches), signin_failed otherwise.
 * @param {{ status: number, body: unknown } | undefined} response
 * @returns {Classification}
 */
export function classifySignIn(response) {
  const status = Number(response?.status) || 0;
  const rawError = /** @type {{ error?: unknown } | undefined} */ (response?.body)?.error;
  const error = text(rawError).replace(/[^a-z0-9_]/gi, "").slice(0, 40);
  const detail = `HTTP ${status || "unknown"}${error ? `, ${error}` : ""}`;
  if (error.toLowerCase() === "invalid_grant") {
    return {
      code: "signin_stale_password",
      ok: false,
      line: `${PREFIX}could not sign the test user in first (${detail}). AUTH0_E2E_USERNAME and AUTH0_E2E_PASSWORD no longer match the tenant, or the realm is wrong.`,
    };
  }
  return {
    code: "signin_failed",
    ok: false,
    line: `${PREFIX}could not sign the test user in first (${detail}). This is not a wrong password: the user may be blocked, the client may lack the password-realm grant, or Auth0 may be limiting sign-ins.`,
  };
}

export const NETWORK_LINE = /** @type {Classification} */ ({
  code: "network",
  ok: false,
  line: `${PREFIX}could not reach Auth0 (network error or no answer in time). Check the network connection and any VPN.`,
});

/**
 * Line for an error thrown while checking. Only fetch, network and timeout errors count as
 * "could not reach Auth0".
 * @param {unknown} error
 * @returns {Classification}
 */
export function classifyError(error) {
  const e = /** @type {{ name?: unknown, message?: unknown, cause?: { code?: unknown } } | null | undefined} */ (error);
  const name = typeof e?.name === "string" ? e.name : "";
  const networkName = ["TimeoutError", "AbortError", "FetchError"].includes(name);
  const causeCode = e?.cause?.code;
  const networkCause =
    typeof causeCode === "string" && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR)/.test(causeCode);
  // fetch() rejects with a TypeError whose message is "fetch failed" when the network fails.
  const fetchFailed = name === "TypeError" && /fetch failed/i.test(String(e?.message));
  if (networkName || networkCause || fetchFailed) return NETWORK_LINE;
  const safe = name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error";
  return {
    code: "other",
    ok: false,
    line: `${PREFIX}failed for another reason (unexpected error ${safe}). Not a known cause.`,
  };
}
