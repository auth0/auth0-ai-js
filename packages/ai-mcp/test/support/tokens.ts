/**
 * Token utilities for tests: key generation, JWKS export and access token minting.
 *
 * Written and tested against jose 6.
 */

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet, JWK, JWTHeaderParameters, JWTPayload } from "jose";

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

export interface TestKey {
  kid: string;
  alg: string;
  privateKey: GeneratedKeyPair["privateKey"];
  /** Public JWK including `kid`, `alg` and `use`. */
  publicJwk: JWK;
}

export interface CreateTestKeyOptions {
  kid?: string;
  /** Signing algorithm. Defaults to RS256. */
  alg?: string;
}

let keyCounter = 0;

/** Generates a fresh signing key pair. */
export async function createTestKey(
  options: CreateTestKeyOptions = {}
): Promise<TestKey> {
  const alg = options.alg ?? "RS256";
  const kid = options.kid ?? `test-key-${++keyCounter}`;
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = alg;
  publicJwk.use = "sig";
  return { kid, alg, privateKey, publicJwk };
}

/** Builds a JWKS document from the public halves of the given keys. */
export function exportJwks(...keys: TestKey[]): JSONWebKeySet {
  return { keys: keys.map((key) => ({ ...key.publicJwk })) };
}

export interface MintAccessTokenOptions {
  /** Issuer. Pass `false` to omit the claim. */
  iss?: string | false;
  /** Audience. The claim is omitted when not given; `false` also omits it. */
  aud?: string | string[] | false;
  /** Subject. Pass `false` to omit the claim. */
  sub?: string | false;
  /**
   * Space-delimited scope claim. Omitted when `undefined`; `""` is written
   * as an empty string.
   */
  scope?: string;
  /** Absolute expiry in epoch seconds. Pass `false` to omit the claim. */
  exp?: number | false;
  /** Seconds from now until expiry, used when `exp` is not given. Defaults to 3600. */
  expiresIn?: number;
  /** Issued-at in epoch seconds. Pass `false` to omit the claim. */
  iat?: number | false;
  /** Unique token id. */
  jti?: string;
  /** Extra claims; these win over the named options above. */
  claims?: Record<string, unknown>;
  /** Extra or overriding protected header parameters (for example a different `kid`). */
  header?: Partial<JWTHeaderParameters> & Record<string, unknown>;
}

/** Signs a JWT with `key`. Every claim and header field can be overridden. */
export async function mintAccessToken(
  key: TestKey,
  options: MintAccessTokenOptions = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {};

  if (options.iss !== false) payload.iss = options.iss ?? "https://tenant.example.com/";
  if (options.aud !== false && options.aud !== undefined) payload.aud = options.aud;
  if (options.sub !== false) payload.sub = options.sub ?? "user|1";
  if (options.scope !== undefined) payload["scope"] = options.scope;
  if (options.jti !== undefined) payload.jti = options.jti;
  if (options.iat !== false) payload.iat = options.iat ?? now;
  if (options.exp !== false) {
    payload.exp = options.exp ?? now + (options.expiresIn ?? 3600);
  }
  Object.assign(payload, options.claims);

  const header = {
    alg: key.alg,
    kid: key.kid,
    typ: "at+jwt",
    ...options.header,
  } as JWTHeaderParameters;

  return new SignJWT(payload).setProtectedHeader(header).sign(key.privateKey);
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Builds an unsigned (`alg: none`) token for negative tests. */
export function mintUnsignedToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {}
): string {
  return `${base64url({ alg: "none", typ: "JWT", ...header })}.${base64url(claims)}.`;
}
