/**
 * Downstream API oracle. Verifies a presented bearer JWT the way a real
 * resource server would and returns a structured verdict. Usable directly as a
 * function or as an MSW handler for a downstream URL.
 */

import { HttpResponse, http } from "msw";
import type { HttpHandler } from "msw";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTPayload } from "jose";

export interface DownstreamOracleOptions {
  /** Keys trusted to sign tokens (the test JWKS). */
  jwks: JSONWebKeySet;
  issuer: string;
  audience: string;
  /** Scope(s) that must all be present in the `scope` or `scp` claim. */
  requiredScope?: string | string[];
  /** Accepted signature algorithms. Defaults to RS256. */
  algorithms?: string[];
}

export type DownstreamRejection =
  | "missing_token"
  | "malformed"
  | "expired"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "missing_scope";

export type DownstreamVerdict =
  | { ok: true; status: 200; claims: JWTPayload; scopes: string[] }
  | {
      ok: false;
      /** 401 for invalid tokens, 403 for insufficient scope. */
      status: 401 | 403;
      reason: DownstreamRejection;
      message: string;
    };

export interface DownstreamCall {
  authorization: string | null;
  verdict: DownstreamVerdict;
}

export interface DownstreamOracle {
  /**
   * Lenient helper for direct calls: accepts a `Bearer <jwt>` header value or
   * a bare JWT.
   */
  verify(authorizationOrToken: string | null | undefined): Promise<DownstreamVerdict>;
  /**
   * Strict Authorization header verification, as used by `handler`. Only
   * `Bearer <jwt>` is accepted. A missing, empty or bare `Bearer` header is
   * `missing_token`; any other scheme, or a raw JWT without a scheme, is
   * `malformed`.
   */
  verifyAuthorization(header: string | null | undefined): Promise<DownstreamVerdict>;
  /** MSW handler answering any method on `url` with the verdict. */
  handler(url: string): HttpHandler;
  /** Every call seen by `verify` and by handlers created from this oracle. */
  readonly calls: DownstreamCall[];
  reset(): void;
}

function scopesOf(payload: JWTPayload): string[] {
  const scope = payload["scope"];
  const scp = payload["scp"];
  const split = (value: string) => value.split(/\s+/).filter((s) => s.length > 0);
  const fromScope = typeof scope === "string" ? split(scope) : [];
  const fromScp =
    typeof scp === "string"
      ? split(scp)
      : Array.isArray(scp)
        ? scp.filter((s): s is string => typeof s === "string")
        : [];
  return [...fromScope, ...fromScp];
}

function reject(
  status: 401 | 403,
  reason: DownstreamRejection,
  message: string
): DownstreamVerdict {
  return { ok: false, status, reason, message };
}

function mapJoseError(err: unknown): DownstreamVerdict {
  const code = (err as { code?: string } | null)?.code;
  const claim = (err as { claim?: string } | null)?.claim;
  const message = err instanceof Error ? err.message : String(err);

  if (code === "ERR_JWT_EXPIRED") return reject(401, "expired", message);
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && claim === "iss") {
    return reject(401, "wrong_issuer", message);
  }
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && claim === "aud") {
    return reject(401, "wrong_audience", message);
  }
  if (
    code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
    code === "ERR_JWKS_NO_MATCHING_KEY" ||
    code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS" ||
    code === "ERR_JOSE_ALG_NOT_ALLOWED"
  ) {
    return reject(401, "bad_signature", message);
  }
  return reject(401, "malformed", message);
}

export function createDownstreamOracle(
  options: DownstreamOracleOptions
): DownstreamOracle {
  const keySet = createLocalJWKSet(options.jwks);
  const required =
    options.requiredScope === undefined
      ? []
      : Array.isArray(options.requiredScope)
        ? options.requiredScope
        : [options.requiredScope];
  const calls: DownstreamCall[] = [];

  async function verifyToken(token: string): Promise<DownstreamVerdict> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: options.algorithms ?? ["RS256"],
        requiredClaims: ["exp", "sub"],
      }));
    } catch (err) {
      return mapJoseError(err);
    }

    const scopes = scopesOf(payload);
    const missing = required.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      return reject(403, "missing_scope", `missing required scope: ${missing.join(" ")}`);
    }
    return { ok: true, status: 200, claims: payload, scopes };
  }

  async function record(
    authorization: string | null | undefined,
    verdict: DownstreamVerdict
  ): Promise<DownstreamVerdict> {
    calls.push({ authorization: authorization ?? null, verdict });
    return verdict;
  }

  async function verify(
    authorizationOrToken: string | null | undefined
  ): Promise<DownstreamVerdict> {
    const raw = authorizationOrToken?.trim() ?? "";
    const token = raw.replace(/^Bearer +/i, "");
    const verdict =
      token.length === 0 || /^Bearer$/i.test(token)
        ? reject(401, "missing_token", "no bearer token presented")
        : await verifyToken(token);
    return record(authorizationOrToken, verdict);
  }

  async function verifyAuthorization(
    header: string | null | undefined
  ): Promise<DownstreamVerdict> {
    const raw = header?.trim() ?? "";
    let verdict: DownstreamVerdict;
    if (raw.length === 0 || /^Bearer$/i.test(raw)) {
      verdict = reject(401, "missing_token", "no bearer token presented");
    } else {
      const match = /^Bearer +(\S+)$/i.exec(raw);
      verdict = match
        ? await verifyToken(match[1]!)
        : reject(401, "malformed", "Authorization header must use the Bearer scheme");
    }
    return record(header, verdict);
  }

  return {
    verify,
    verifyAuthorization,
    handler(url: string) {
      return http.all(url, async ({ request }) => {
        const verdict = await verifyAuthorization(request.headers.get("authorization"));
        if (verdict.ok) {
          return HttpResponse.json({ ok: true, scopes: verdict.scopes }, { status: 200 });
        }
        return HttpResponse.json(
          { ok: false, reason: verdict.reason, message: verdict.message },
          { status: verdict.status }
        );
      });
    },
    calls,
    reset() {
      calls.length = 0;
    },
  };
}
