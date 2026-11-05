/** DPoP helpers for tests (RFC 9449). Keys are generated at runtime; nothing is stored. */
import { createHash, randomUUID } from "node:crypto";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";
import type { E2eEnv } from "./env.js";
import { decodeClaims } from "./tokens.js";

export interface DpopKeyPair {
  privateKey: CryptoKey;
  /** Public JWK as embedded in proof headers. */
  jwk: JWK;
  /** JWK SHA-256 thumbprint, the value of `cnf.jkt` in a bound token. */
  jkt: string;
}

/** Generates a fresh ES256 key pair. */
export async function generateDpopKeyPair(): Promise<DpopKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk) };
}

export interface DpopProofInput {
  /** HTTP method of the request the proof is for. */
  htm: string;
  /** Exact request URL the server sees (no query or fragment is added). */
  htu: string;
  /** When set, adds `ath`, the base64url SHA-256 of this access token. */
  accessToken?: string;
  /** Server-provided nonce, if any. */
  nonce?: string;
  /** Overrides `iat` (seconds). Default: now. */
  iat?: number;
  /** Overrides `jti`. Default: a random UUID. */
  jti?: string;
}

/** Builds a signed DPoP proof JWT (`typ: dpop+jwt`, public key in the header). */
export async function buildDpopProof(keys: DpopKeyPair, input: DpopProofInput): Promise<string> {
  const payload: Record<string, unknown> = {
    htm: input.htm.toUpperCase(),
    htu: input.htu,
    jti: input.jti ?? randomUUID(),
    ...(input.accessToken !== undefined && {
      ath: createHash("sha256").update(input.accessToken).digest("base64url"),
    }),
    ...(input.nonce !== undefined && { nonce: input.nonce }),
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: keys.jwk })
    .setIssuedAt(input.iat)
    .sign(keys.privateKey);
}

export interface BoundToken {
  accessToken: string;
  keys: DpopKeyPair;
}

/**
 * Asks the tenant for a user token bound to a fresh DPoP key (RFC 9449), with the password-realm
 * grant of the login client. Returns undefined when the tenant answers with a token that carries no
 * `cnf` claim, which is what a tenant without sender-constrained tokens does: it ignores the proof
 * and issues a Bearer token. Nothing is changed in the tenant.
 */
export async function requestDpopBoundUserToken(env: E2eEnv, audience: string): Promise<BoundToken | undefined> {
  const keys = await generateDpopKeyPair();
  const url = `https://${env.domain}/oauth/token`;
  const form = new URLSearchParams({
    grant_type: "http://auth0.com/oauth/grant-type/password-realm",
    realm: env.realm,
    username: env.username,
    password: env.password,
    client_id: env.loginClientId,
    client_secret: env.loginClientSecret,
    audience,
    scope: "tool:whoami",
  });
  let nonce: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: await buildDpopProof(keys, { htm: "POST", htu: url, ...(nonce !== undefined && { nonce }) }),
      },
      body: form,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const retryNonce = response.headers.get("dpop-nonce");
    if (response.status === 400 && retryNonce !== null && nonce === undefined) {
      nonce = retryNonce;
      continue;
    }
    const accessToken = body["access_token"];
    if (response.status !== 200 || typeof accessToken !== "string") return undefined;
    const bound = decodeClaims(accessToken)["cnf"] !== undefined;
    return bound ? { accessToken, keys } : undefined;
  }
  return undefined;
}
