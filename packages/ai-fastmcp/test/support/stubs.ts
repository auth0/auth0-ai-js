/**
 * Stubs for the unit suites. Mocks are acceptable only here; the integration suites use a real
 * FastMCP server, a real MCP client and real signed tokens.
 */
import type { IncomingMessage } from "node:http";
import type { McpClient, Principal, RequestScopedMcpClient, VerifiedCaller } from "@auth0/ai-mcp";

export const AUDIENCE = "https://mcp.example.com/mcp";

/** A request as FastMCP's `authenticate` receives it, with lower-case header names like Node. */
export function fakeRequest(
  headers: Record<string, string | string[] | undefined> = {},
  url = "/mcp",
  method = "POST",
): IncomingMessage {
  return { headers, url, method } as unknown as IncomingMessage;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Base64url JSON, the form of a JWT segment. */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned token with the given claims. Good enough for stubs that never verify signatures. */
export function fakeJwt(claims: Record<string, unknown> = {}): string {
  return `${segment({ alg: "RS256" })}.${segment({ sub: "user|1", ...claims })}.c2ln`;
}

export function principalOf(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: "user|1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    scopes: ["read:orders"],
    permissions: null,
    clientId: "client-a",
    orgId: null,
    ...overrides,
  };
}

export function scopedClientOf(principal: Principal): RequestScopedMcpClient {
  const unsupported = async () => {
    throw new Error("not used in this test");
  };
  return Object.freeze({
    getTokenOnBehalfOf: unsupported,
    getClientCredentialsToken: unsupported,
    getTokenForConnection: unsupported,
    getPrincipal: () => principal,
  });
}

export interface StubClientOptions {
  audience?: string | undefined;
  domain?: string | undefined;
  dpopMode?: McpClient["dpopMode"];
  /** What `verifyAccessToken` does. Defaults to resolving a caller for `principalOf()`. */
  verify?: (options: unknown) => Promise<VerifiedCaller>;
}

export interface StubClient extends McpClient {
  verifyCalls: unknown[];
}

/** A client whose verification is a function the test controls. */
export function stubClient(options: StubClientOptions = {}): StubClient {
  const verifyCalls: unknown[] = [];
  const issued = new WeakSet<object>();
  const client: StubClient = {
    audience: "audience" in options ? options.audience : AUDIENCE,
    domain: "domain" in options ? options.domain : "tenant.example.com",
    dpopMode: options.dpopMode ?? "allowed",
    verifyCalls,
    async verifyAccessToken(verifyOptions) {
      verifyCalls.push(verifyOptions);
      if (options.verify !== undefined) return options.verify(verifyOptions);
      const caller: VerifiedCaller = Object.freeze({ principal: principalOf() });
      issued.add(caller);
      return caller;
    },
    withToken(caller) {
      return scopedClientOf(caller.principal);
    },
  };
  return client;
}

/** Resolves a caller for the given principal. */
export function callerFor(principal: Principal): VerifiedCaller {
  return Object.freeze({ principal });
}

/** Runs `fn` with environment variables set, then restores them. */
export async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Reads a thrown value out of a promise, failing the test when nothing was thrown. */
export async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}
