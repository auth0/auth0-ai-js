/**
 * MSW v2 handlers that emulate an Auth0 tenant: OIDC discovery, JWKS and a
 * token endpoint supporting RFC 8693 token exchange and client_credentials.
 * Issued access tokens are real signed JWTs so a downstream oracle can verify them.
 */

import { HttpResponse, http } from "msw";
import type { HttpHandler } from "msw";
import { randomUUID } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { exportJwks, mintAccessToken } from "./tokens.js";
import type { TestKey } from "./tokens.js";

export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** How the token endpoint reports the granted scope. */
export type ScopeMode =
  | { kind: "echo" }
  | { kind: "fixed"; scope: string }
  | { kind: "absent" }
  | { kind: "empty" };

export const scopeMode = {
  /** Grant exactly what was requested (no `scope` field when nothing was requested). */
  echo: { kind: "echo" } as ScopeMode,
  /** Always grant the given scope string, whatever was requested. */
  fixed: (scope: string): ScopeMode => ({ kind: "fixed", scope }),
  /** Omit the `scope` field from the JSON response. */
  absent: { kind: "absent" } as ScopeMode,
  /** Return `scope: ""`. */
  empty: { kind: "empty" } as ScopeMode,
};

export type FailureGrant = "token-exchange" | "client_credentials" | "any";

export interface Auth0Failure {
  status: number;
  /** Response body. Defaults to `{ error: "invalid_request" }`. */
  body?: Record<string, unknown>;
  /** Which grant fails. Defaults to `token-exchange`. */
  grant?: FailureGrant;
}

export interface Auth0HandlerOptions {
  /** Tenant domain, without scheme. Defaults to `tenant.example.com`. */
  domain?: string;
  /** Signing key. Its public half is served from the JWKS endpoint. */
  key: TestKey;
  scope?: ScopeMode;
  /** `expires_in` seconds on issued tokens. Defaults to 3600. */
  expiresIn?: number;
  failure?: Auth0Failure | null;
  /** Audience used when a request carries none. */
  defaultAudience?: string;
}

export interface RecordedTokenRequest {
  grantType: string;
  params: Record<string, string>;
  /** Client id from the form body or, failing that, the HTTP Basic header. */
  clientId: string | undefined;
}

export interface Auth0HandlerState {
  /**
   * Number of RFC 8693 token-exchange requests received, including requests
   * that were rejected by validation or answered with a configured failure.
   */
  exchangeCount: number;
  /** Number of token-exchange requests answered with a 200 and an issued token. */
  successfulExchangeCount: number;
  /** Number of client_credentials requests received. */
  clientCredentialsCount: number;
  lastExchangeRequest: RecordedTokenRequest | null;
  lastClientCredentialsRequest: RecordedTokenRequest | null;
  /** Every token endpoint request in arrival order. */
  requests: RecordedTokenRequest[];
  scope: ScopeMode;
  expiresIn: number;
  failure: Auth0Failure | null;
  /**
   * Milliseconds a configured failure waits before it is answered, so concurrent callers can
   * join the failing exchange the way they would behind a real network round trip.
   */
  failureDelayMs: number;
  /** Restores counters, recordings and configuration to the initial options. */
  reset(): void;
}

export interface Auth0Handlers {
  handlers: HttpHandler[];
  state: Auth0HandlerState;
  /** `https://<domain>/` */
  issuer: string;
  tokenEndpoint: string;
  jwksUri: string;
  key: TestKey;
}

function resolveScope(mode: ScopeMode, requested: string | undefined): string | undefined {
  switch (mode.kind) {
    case "echo":
      return requested;
    case "fixed":
      return mode.scope;
    case "absent":
      return undefined;
    case "empty":
      return "";
  }
}

function oauthError(status: number, error: string, description: string) {
  return HttpResponse.json({ error, error_description: description }, { status });
}

/** Extracts the client id from an HTTP Basic `Authorization` header. */
function basicClientId(header: string | null): string | undefined {
  const match = /^Basic +(\S+)$/i.exec(header ?? "");
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const id = decoded.split(":")[0];
  return id ? decodeURIComponent(id) : undefined;
}

export function createAuth0Handlers(options: Auth0HandlerOptions): Auth0Handlers {
  const domain = options.domain ?? "tenant.example.com";
  const issuer = `https://${domain}/`;
  const tokenEndpoint = `https://${domain}/oauth/token`;
  const jwksUri = `https://${domain}/.well-known/jwks.json`;
  const initialScope = options.scope ?? scopeMode.echo;
  const initialExpiresIn = options.expiresIn ?? 3600;
  const initialFailure = options.failure ?? null;

  const state: Auth0HandlerState = {
    exchangeCount: 0,
    successfulExchangeCount: 0,
    clientCredentialsCount: 0,
    lastExchangeRequest: null,
    lastClientCredentialsRequest: null,
    requests: [],
    scope: initialScope,
    expiresIn: initialExpiresIn,
    failure: initialFailure,
    failureDelayMs: 0,
    reset() {
      state.exchangeCount = 0;
      state.successfulExchangeCount = 0;
      state.clientCredentialsCount = 0;
      state.lastExchangeRequest = null;
      state.lastClientCredentialsRequest = null;
      state.requests = [];
      state.scope = initialScope;
      state.expiresIn = initialExpiresIn;
      state.failure = initialFailure;
      state.failureDelayMs = 0;
    },
  };

  const subjectKeys = createLocalJWKSet(exportJwks(options.key));

  async function issue(
    params: Record<string, string>,
    clientId: string,
    sub: string,
    granted: string | undefined,
    orgId: unknown
  ): Promise<string> {
    return mintAccessToken(options.key, {
      iss: issuer,
      aud: params["audience"] ?? options.defaultAudience ?? false,
      sub,
      scope: granted,
      expiresIn: state.expiresIn,
      jti: randomUUID(),
      claims: {
        client_id: clientId,
        ...(orgId !== undefined && { org_id: orgId }),
      },
    });
  }

  const handlers = [
    http.get(`https://${domain}/.well-known/openid-configuration`, () =>
      HttpResponse.json({
        issuer,
        jwks_uri: jwksUri,
        token_endpoint: tokenEndpoint,
        id_token_signing_alg_values_supported: [options.key.alg],
      })
    ),

    http.get(jwksUri, () => HttpResponse.json(exportJwks(options.key))),

    http.post(tokenEndpoint, async ({ request }) => {
      const params = Object.fromEntries(new URLSearchParams(await request.text()));
      const grantType = params["grant_type"] ?? "";
      const clientId = params["client_id"] || basicClientId(request.headers.get("authorization"));
      const recorded: RecordedTokenRequest = { grantType, params, clientId };
      state.requests.push(recorded);

      const isExchange = grantType === TOKEN_EXCHANGE_GRANT;
      const isClientCredentials = grantType === "client_credentials";

      if (isExchange) {
        state.exchangeCount++;
        state.lastExchangeRequest = recorded;
      } else if (isClientCredentials) {
        state.clientCredentialsCount++;
        state.lastClientCredentialsRequest = recorded;
      } else {
        return HttpResponse.json(
          { error: "unsupported_grant_type", error_description: `Unsupported: ${grantType}` },
          { status: 400 }
        );
      }

      const failure = state.failure;
      if (failure) {
        const target = failure.grant ?? "token-exchange";
        const applies =
          target === "any" ||
          (target === "token-exchange" && isExchange) ||
          (target === "client_credentials" && isClientCredentials);
        if (applies) {
          if (state.failureDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.failureDelayMs));
          return HttpResponse.json(failure.body ?? { error: "invalid_request" }, {
            status: failure.status,
          });
        }
      }

      if (!clientId) {
        return oauthError(400, "invalid_request", "client_id is required");
      }

      let sub = `${clientId}@clients`;
      let orgId: unknown;
      if (isExchange) {
        const subjectToken = params["subject_token"];
        if (!subjectToken) {
          return oauthError(400, "invalid_request", "subject_token is required");
        }
        if (!params["subject_token_type"]) {
          return oauthError(400, "invalid_request", "subject_token_type is required");
        }
        try {
          const { payload } = await jwtVerify(subjectToken, subjectKeys, { issuer });
          sub = payload.sub ?? "unknown-subject";
          orgId = payload["org_id"];
        } catch (err) {
          return oauthError(
            400,
            "invalid_grant",
            `invalid subject_token: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const granted = resolveScope(state.scope, params["scope"]);
      const accessToken = await issue(params, clientId, sub, granted, orgId);
      if (isExchange) state.successfulExchangeCount++;

      return HttpResponse.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: state.expiresIn,
        ...(granted !== undefined && { scope: granted }),
        ...(isExchange && { issued_token_type: ACCESS_TOKEN_TYPE }),
      });
    }),
  ];

  return { handlers, state, issuer, tokenEndpoint, jwksUri, key: options.key };
}
