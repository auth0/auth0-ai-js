/**
 * The real callers of the suite: distinct subjects that the tenant issues tokens for. Two are
 * users (password realm, same login client), two are clients (client credentials). Each has its
 * own `sub`, which is what the isolation scenarios compare.
 */
import type { E2eEnv } from "./env.js";
import { decodeClaims, getClientCredentialsToken, getUserToken } from "./tokens.js";

/** Scopes requested for the user callers. Both are scopes of the MCP API. */
export const USER_SCOPES = ["tool:whoami", "tool:delegate"] as const;

export interface Caller {
  /** Short label for test titles. */
  name: string;
  kind: "user" | "machine";
  /** The OAuth client the token is issued to. It appears as `azp` in the token. */
  clientId: string;
  /** Scopes the token is expected to carry. */
  scopes: readonly string[];
  /** A token for the MCP API (or `audience`). Memoized unless `fresh` is set. */
  token(options?: { audience?: string; fresh?: boolean }): Promise<string>;
}

/** The subject of a token this suite minted. Reads the payload without verifying it. */
export function subjectOf(token: string): string {
  const sub = decodeClaims(token)["sub"];
  if (typeof sub !== "string") throw new Error("The minted token carries no subject.");
  return sub;
}

export function firstUser(env: E2eEnv): Caller {
  return {
    name: "first user",
    kind: "user",
    clientId: env.loginClientId,
    scopes: USER_SCOPES,
    token: (options = {}) =>
      getUserToken(env, { scope: USER_SCOPES.join(" "), ...(options.audience !== undefined && { audience: options.audience }), ...(options.fresh === true && { fresh: true }) }),
  };
}

export function secondUser(env: E2eEnv): Caller {
  return {
    name: "second user",
    kind: "user",
    clientId: env.loginClientId,
    scopes: USER_SCOPES,
    token: (options = {}) =>
      getUserToken(env, {
        user: "second",
        scope: USER_SCOPES.join(" "),
        ...(options.audience !== undefined && { audience: options.audience }),
        ...(options.fresh === true && { fresh: true }),
      }),
  };
}

/** A client that holds only `tool:whoami` on the MCP API. */
export function limitedClient(env: E2eEnv): Caller {
  return {
    name: "limited client",
    kind: "machine",
    clientId: env.limitedClientId,
    scopes: ["tool:whoami"],
    token: (options = {}) =>
      getClientCredentialsToken(env, {
        audience: options.audience ?? env.mcpAudience,
        clientId: env.limitedClientId,
        clientSecret: env.limitedClientSecret,
        ...(options.fresh === true && { fresh: true }),
      }),
  };
}

/** A second client with a grant on the MCP API (`tool:whoami`). */
export function testerClient(env: E2eEnv): Caller {
  return {
    name: "tester client",
    kind: "machine",
    clientId: env.testerClientId,
    scopes: ["tool:whoami"],
    token: (options = {}) =>
      getClientCredentialsToken(env, {
        audience: options.audience ?? env.mcpAudience,
        clientId: env.testerClientId,
        clientSecret: env.testerClientSecret,
        ...(options.fresh === true && { fresh: true }),
      }),
  };
}
