import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupServer } from "msw/node";
import { MemoryIndexedTokenStore, UnauthenticatedError, createMcpClient } from "../../src/index.js";
import type { McpClient, TokenStore } from "../../src/index.js";
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from "../support/index.js";
import type { MintAccessTokenOptions, TestKey } from "../support/index.js";

/**
 * Pins statements of the guides that depend on how the real core client and the tenant
 * answer: the scope of an exchange without `scope`, the session part of the cache key, the
 * five second rule and the calls that outlive the caller's token. Auth0 is replaced by MSW.
 */

const AUDIENCE = "https://mcp.example.com/mcp";
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
