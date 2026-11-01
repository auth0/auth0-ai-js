import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { readFileSync } from "node:fs";
import { MemoryIndexedTokenStore, UnauthenticatedError, createMcpClient, createMcpHandler } from "../../src/index.js";
import type { McpClient, TokenStore } from "../../src/index.js";
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from "../support/index.js";
import type { MintAccessTokenOptions, TestKey } from "../support/index.js";

/**
 * Pins statements of the guides that depend on how the real core client and the tenant
 * answer: the scope of an exchange without `scope`, the session part of the cache key, the
 * five second rule and the calls that outlive the caller's token. Auth0 is replaced by MSW.
 */

const AUDIENCE = "https://mcp.example.com/mcp";

function guide(name: string): string {
  return readFileSync(new URL(`../../docs/${name}`, import.meta.url), "utf8");
}
const DOWNSTREAM = "https://reports-api.example.com";

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  tenant = createAuth0Handlers({ key, scope: scopeMode.echo });
  server.listen({ onUnhandledRequest: "error" });
  server.use(...tenant.handlers);
});
afterEach(() => {
  vi.useRealTimers();
  tenant.state.reset();
  server.resetHandlers(...tenant.handlers);
});
afterAll(() => server.close());

function makeClient(tokenStore?: TokenStore): McpClient {
  return createMcpClient({
    domain: "tenant.example.com",
    audience: AUDIENCE,
    clientId: "mcp-client",
    clientSecret: "secret",
    ...(tokenStore !== undefined && { tokenStore }),
  });
}

async function callerFor(client: McpClient, token: Omit<MintAccessTokenOptions, "iss" | "aud"> = {}) {
  const accessToken = await mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: "user|1",
    scope: "mcp:access",
    ...token,
  });
  return client.withToken(await client.verifyAccessToken({ accessToken, scheme: "bearer" }));
}

describe("an exchange without scope (OnBehalfOf.md)", () => {
  it("sends no scope, accepts the answer without one and reports an empty grant", async () => {
    tenant.state.scope = scopeMode.absent;
    const scoped = await callerFor(makeClient());

    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });

    expect(tenant.state.lastExchangeRequest?.params["scope"]).toBeUndefined();
    expect(result.scope).toBeUndefined();
    expect(result.grantedScopes).toEqual([]);
  });
});

describe("the session part of the cache key (TokenCaching.md)", () => {
  const request = { audience: DOWNSTREAM, scope: "read:reports" };

  it("reuses a token for the same access token", async () => {
    const client = makeClient(new MemoryIndexedTokenStore());
    const accessToken = await mintAccessToken(key, {
      iss: tenant.issuer,
      aud: AUDIENCE,
      sub: "user|1",
      scope: "mcp:access",
      jti: "token-1",
    });
    const caller = await client.verifyAccessToken({ accessToken, scheme: "bearer" });

    await client.withToken(caller).getTokenOnBehalfOf(request);
    await client.withToken(caller).getTokenOnBehalfOf(request);

    expect(tenant.state.successfulExchangeCount).toBe(1);
  });

  it("exchanges again for a new access token of the same user when the tokens carry no sid", async () => {
    const client = makeClient(new MemoryIndexedTokenStore());

    await (await callerFor(client, { jti: "token-1" })).getTokenOnBehalfOf(request);
    await (await callerFor(client, { jti: "token-2" })).getTokenOnBehalfOf(request);

    expect(tenant.state.successfulExchangeCount).toBe(2);
  });

  it("exchanges again when the tokens carry neither sid nor jti", async () => {
    const client = makeClient(new MemoryIndexedTokenStore());

    await (await callerFor(client, { iat: 1_000_000_000 })).getTokenOnBehalfOf(request);
    await (await callerFor(client, { iat: 1_000_000_001 })).getTokenOnBehalfOf(request);

    expect(tenant.state.successfulExchangeCount).toBe(2);
  });

  it("reuses a token across access tokens that share a sid", async () => {
    const client = makeClient(new MemoryIndexedTokenStore());

    await (await callerFor(client, { jti: "token-1", claims: { sid: "session-1" } })).getTokenOnBehalfOf(request);
    await (await callerFor(client, { jti: "token-2", claims: { sid: "session-1" } })).getTokenOnBehalfOf(request);

    expect(tenant.state.successfulExchangeCount).toBe(1);
  });
});

describe("a caller token in its last seconds (KnownLimitations.md)", () => {
  const request = { audience: DOWNSTREAM, scope: "read:reports" };
  const lastSeconds = () => ({ exp: Math.floor(Date.now() / 1000) + 3 });

  it("is exchanged normally without a token store", async () => {
    const scoped = await callerFor(makeClient(), lastSeconds());

    await expect(scoped.getTokenOnBehalfOf(request)).resolves.toMatchObject({ grantedScopes: ["read:reports"] });
    expect(tenant.state.successfulExchangeCount).toBe(1);
  });

  it("fails as UnauthenticatedError before any request with a token store", async () => {
    const scoped = await callerFor(makeClient(new MemoryIndexedTokenStore()), lastSeconds());

    await expect(scoped.getTokenOnBehalfOf(request)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(tenant.state.exchangeCount).toBe(0);
  });
});

describe("calls after the caller's token has expired (RequestContext.md)", () => {
  const request = { audience: DOWNSTREAM, scope: "read:reports" };

  async function expiredCaller(store?: TokenStore) {
    const scoped = await callerFor(makeClient(store), { exp: Math.floor(Date.now() / 1000) + 30 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    return scoped;
  }

  it("stops an on behalf of exchange: the tenant refuses the expired subject token", async () => {
    const scoped = await expiredCaller();

    await expect(scoped.getTokenOnBehalfOf(request)).rejects.toThrow("The token operation failed.");
    expect(tenant.state.successfulExchangeCount).toBe(0);
  });

  it("stops an on behalf of exchange before any request when a token store is set", async () => {
    const scoped = await expiredCaller(new MemoryIndexedTokenStore());

    await expect(scoped.getTokenOnBehalfOf(request)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(tenant.state.exchangeCount).toBe(0);
  });

  it("keeps client credentials working, because they do not use the caller's token", async () => {
    const scoped = await expiredCaller();

    await expect(scoped.getClientCredentialsToken(request)).resolves.toMatchObject({
      grantedScopes: ["read:reports"],
    });
  });
});

describe("a failed token request (Errors.md, OnBehalfOf.md, RequestContext.md, TokenVault.md)", () => {
  const request = { audience: DOWNSTREAM, scope: "read:reports" };

  it("keeps code, statusCode and a copy of the headers on the sanitized error, and nothing of the body", async () => {
    const scoped = await callerFor(makeClient());
    server.use(
      http.post(tenant.tokenEndpoint, () =>
        HttpResponse.json(
          { error: "too_many_requests", error_description: "upstream detail that must not leak" },
          { status: 429, headers: { "Retry-After": "7" } },
        ),
      ),
    );

    const error = (await scoped.getTokenOnBehalfOf(request).catch((reason: unknown) => reason)) as Error & {
      code?: string;
      statusCode?: number;
      headers?: Headers | Record<string, string>;
      cause?: { headers?: unknown };
    };

    expect(error.message).toBe("The token operation failed.");
    expect(error.statusCode).toBe(429);
    expect(typeof error.code).toBe("string");
    const retryAfter =
      error.headers instanceof Headers ? error.headers.get("retry-after") : error.headers?.["retry-after"];
    expect(retryAfter).toBe("7");
    expect(error.headers).not.toBe(error.cause?.headers);
    expect(JSON.stringify(error)).not.toContain("upstream detail");
    for (const name of ["Errors.md", "OnBehalfOf.md", "RequestContext.md", "TokenVault.md"]) {
      expect(guide(name), name).not.toContain("from `cause`");
    }
    expect(guide("Errors.md")).toContain("`Retry-After`");
  });
});

describe("an outage of the tenant (KnownLimitations.md)", () => {
  it("answers 401 invalid_token and stays silent for onError when the key set cannot be fetched", async () => {
    const client = makeClient();
    const accessToken = await mintAccessToken(key, {
      iss: tenant.issuer,
      aud: AUDIENCE,
      sub: "user|1",
      scope: "mcp:access",
    });
    server.use(http.get(tenant.jwksUri, () => new HttpResponse(null, { status: 503 })));
    const seen: unknown[] = [];
    const handle = createMcpHandler({ client, onError: (error) => seen.push(error), handler: async () => new Response("ok") });

    const response = await handle(
      new Request(AUDIENCE, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(seen).toEqual([]);
    expect(guide("KnownLimitations.md")).toContain("A tenant outage answers 401");
  });
});
