/**
 * Checks that no secret reached a place it must not. A JWT is searched for whole and by its
 * payload and signature segments, so a partial echo is caught too. Failures name the place and the
 * kind of secret, never the value.
 */
import { expect } from "vitest";

/** The pieces of a JWT that identify it: the whole token, its payload and its signature. */
export function fragmentsOf(token: string): string[] {
  const parts = token.split(".");
  return [token, ...parts.slice(1)].filter((part) => part.length >= 12);
}

/** Fails when `text` holds any fragment of any of the tokens. */
export function expectNoTokens(place: string, text: string, tokens: readonly string[]): void {
  tokens.forEach((token, index) => {
    const leaked = fragmentsOf(token).some((fragment) => text.includes(fragment));
    expect(leaked, `${place} carries a fragment of token #${index + 1}`).toBe(false);
  });
}

/** Fails when `text` holds any of the literal secrets (client secrets, passwords, canaries). */
export function expectNoSecrets(place: string, text: string, secrets: readonly string[]): void {
  secrets
    .filter((secret) => secret.length >= 6)
    .forEach((secret, index) => {
      expect(text.includes(secret), `${place} carries secret #${index + 1}`).toBe(false);
    });
}

/** Text that only a verification library produces. A response from this adapter never contains it. */
export const LIBRARY_TEXT = /signature verification|JWS|JWKS|JWT|unexpected "|"iss"|"aud"|"exp"|\bjose\b|ERR_[A-Z_]+|Invalid Compact/i;
