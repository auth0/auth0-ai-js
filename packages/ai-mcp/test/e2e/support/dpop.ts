/** DPoP helpers for tests (RFC 9449). Keys are generated at runtime; nothing is stored. */
import { createHash, randomUUID } from "node:crypto";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";

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
