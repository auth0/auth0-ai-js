import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CachedToken, IndexedTokenStore, TokenStore } from "@auth0/ai-mcp";
import { InvalidConfigurationError, MemoryIndexedTokenStore, createEncryptedTokenStore, createMcpClient } from "@auth0/ai-mcp";
import type { FastMcpAuth } from "../../src/index.js";
import { createFastMcpAuth } from "../../src/index.js";
import { DOMAIN, createRig } from "../integration/harness.js";
import { scopeMode } from "../support/index.js";
import { bearer, fakeRequest } from "../support/stubs.js";
import { documented, loadSnippet } from "./guides.js";
import { withEnv } from "./server.js";

/** Pins every claim of docs/TokenCaching.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const AUDIENCE = "https://mcp.example.com/mcp";
const API = "https://api.example.com";

type Options = Parameters<typeof createFastMcpAuth>[0];

function adapter(extra: Record<string, unknown> = {}): FastMcpAuth {
  return createFastMcpAuth({ domain: DOMAIN, audience: AUDIENCE, clientId: "mcp-client", clientSecret: "secret", ...extra } as Options);
}

async function tokenFor(claims: { sub?: string; sid?: string; jti?: string; nonce?: string } = {}): Promise<string> {
  const { sub, sid, jti, nonce } = claims;
  return rig().token(
    { audience: AUDIENCE },
    {
      ...(sub !== undefined && { sub }),
      ...(jti !== undefined && { jti }),
      claims: { ...(sid !== undefined && { sid }), ...(nonce !== undefined && { nonce }) },
    },
  );
}

async function sessionFor(auth: FastMcpAuth, token: string) {
  return auth.authenticate(fakeRequest(bearer(token)));
}

async function exchange(auth: FastMcpAuth, token: string, scope = "api:read", audience = API) {
  const session = await sessionFor(auth, token);
  return session.mcpClient.getTokenOnBehalfOf({ audience, scope });
}

const count = () => rig().tenant.auth0.state.exchangeCount;

describe("TokenCaching.md: turning the cache on", () => {
  it("exchanges every time without a store", async () => {
    const auth = adapter();
    const token = await tokenFor();
    await exchange(auth, token);
    await exchange(auth, token);
    expect(count()).toBe(2);
    documented("TokenCaching.md", "Caching is optional and off by default: without a `tokenStore`, every call performs a new exchange and nothing is kept.");
  });

  it("returns the stored token and makes no request to the tenant on a repeat call, with the store passed inline", async () => {
    const loaded = await withEnv({ AUTH0_CLIENT_ID: "mcp-client", AUTH0_CLIENT_SECRET: "secret" }, () =>
      loadSnippet("TokenCaching.md", 1, {
        rewrites: [
          ['"your-tenant.us.auth0.com"', JSON.stringify(DOMAIN)],
          ['"https://mcp.example.com/mcp"', JSON.stringify(AUDIENCE)],
        ],
        exportNames: ["auth"],
      }),
    );
    try {
      const auth = loaded.exports["auth"] as FastMcpAuth;
      const token = await tokenFor();
      const first = await exchange(auth, token);
      const second = await exchange(auth, token);
      expect(count()).toBe(1);
      expect(second.accessToken).toBe(first.accessToken);
    } finally {
      loaded.dispose();
    }
    documented(
      "TokenCaching.md",
      "A second `getTokenOnBehalfOf` for the same audience and scopes by the same caller returns the stored token, and no request goes to the tenant.",
    );
  });

  it("does the same with the store given to the client that is passed in", async () => {
    const loaded = await withEnv({ AUTH0_CLIENT_ID: "mcp-client", AUTH0_CLIENT_SECRET: "secret" }, () =>
      loadSnippet("TokenCaching.md", 2, {
        rewrites: [
          ['"your-tenant.us.auth0.com"', JSON.stringify(DOMAIN)],
          ['"https://mcp.example.com/mcp"', JSON.stringify(AUDIENCE)],
        ],
        exportNames: ["auth"],
      }),
    );
    try {
      const auth = loaded.exports["auth"] as FastMcpAuth;
      const token = await tokenFor();
      await exchange(auth, token);
      await exchange(auth, token);
      expect(count()).toBe(1);
    } finally {
      loaded.dispose();
    }
  });
});

describe("TokenCaching.md: what is cached", () => {
  it("caches On Behalf Of results and not client credentials tokens", async () => {
    const auth = adapter({ tokenStore: new MemoryIndexedTokenStore() });
    const session = await sessionFor(auth, await tokenFor());
    await session.mcpClient.getClientCredentialsToken({ audience: API, scope: "api:read" });
    await session.mcpClient.getClientCredentialsToken({ audience: API, scope: "api:read" });
    expect(rig().tenant.auth0.state.clientCredentialsCount).toBe(2);
    await session.mcpClient.getTokenOnBehalfOf({ audience: API, scope: "api:read" });
    await session.mcpClient.getTokenOnBehalfOf({ audience: API, scope: "api:read" });
    expect(count()).toBe(1);
    documented("TokenCaching.md", "**On Behalf Of results** go into the store. Client credentials tokens do not");
  });

  it("keeps callers apart: one caller never receives a token exchanged for another", async () => {
    const auth = adapter({ tokenStore: new MemoryIndexedTokenStore() });
    const alice = await tokenFor({ sub: "user|alice" });
    const bob = await tokenFor({ sub: "user|bob" });
    const a1 = await exchange(auth, alice);
    const b1 = await exchange(auth, bob);
    expect(count()).toBe(2);
    expect(b1.accessToken).not.toBe(a1.accessToken);
    expect((await exchange(auth, alice)).accessToken).toBe(a1.accessToken);
    expect((await exchange(auth, bob)).accessToken).toBe(b1.accessToken);
    expect(count()).toBe(2);
    documented("TokenCaching.md", "The key includes the subject, so the store never hands one caller a token issued for another.");
  });

  it("keys the entry by audience and scopes", async () => {
    const auth = adapter({ tokenStore: new MemoryIndexedTokenStore() });
    const token = await tokenFor();
    await exchange(auth, token, "api:read");
    await exchange(auth, token, "api:read");
    expect(count()).toBe(1);
    await exchange(auth, token, "api:write");
    expect(count()).toBe(2);
    await exchange(auth, token, "api:read", "https://other-api.example.com");
    expect(count()).toBe(3);
    documented("TokenCaching.md", "It also includes the audience, the scopes");
  });

  it("keys the entry by the client that performs the exchange", async () => {
    const shared = new MemoryIndexedTokenStore();
    const first = adapter({ tokenStore: shared, clientId: "client-one" });
    const second = adapter({ tokenStore: shared, clientId: "client-two" });
    const token = await tokenFor();
    await exchange(first, token);
    await exchange(second, token);
    expect(count()).toBe(2);
    await exchange(first, token);
    expect(count()).toBe(2);
    documented("TokenCaching.md", "the client that performs the exchange");
  });

  it("identifies the session by sid, else jti, else the token itself", async () => {
    const reuse = async (a: string, b: string) => {
      const auth = adapter({ tokenStore: new MemoryIndexedTokenStore() });
      rig().tenant.auth0.state.reset();
      await exchange(auth, a);
      await exchange(auth, b);
      return count();
    };
    // The same access token twice: one exchange.
    const plain = await tokenFor({ nonce: "one" });
    expect(await reuse(plain, plain)).toBe(1);
    // Different tokens that share a sid: one exchange, even when their jti differ.
    expect(await reuse(await tokenFor({ sid: "sid-1", jti: "j1" }), await tokenFor({ sid: "sid-1", jti: "j2" }))).toBe(1);
    // Different sids: two exchanges.
    expect(await reuse(await tokenFor({ sid: "sid-1" }), await tokenFor({ sid: "sid-2" }))).toBe(2);
    // No sid, same jti: one exchange.
    expect(await reuse(await tokenFor({ jti: "j1", nonce: "a" }), await tokenFor({ jti: "j1", nonce: "b" }))).toBe(1);
    // No sid, different jti: two exchanges.
    expect(await reuse(await tokenFor({ jti: "j1" }), await tokenFor({ jti: "j2" }))).toBe(2);
    // Neither sid nor jti: different tokens do not share entries.
    expect(await reuse(await tokenFor({ nonce: "a" }), await tokenFor({ nonce: "b" }))).toBe(2);
    documented(
      "TokenCaching.md",
      "The session is the `sid` claim, or the `jti` claim when there is no `sid`, or the token itself when there is neither.",
      "Two different tokens without a `sid` do not share entries.",
    );
  });

  it("compares the scopes the tenant granted, not the ones requested", async () => {
    rig().tenant.auth0.state.scope = scopeMode.fixed("api:read api:write");
    const auth = adapter({ tokenStore: new MemoryIndexedTokenStore() });
    const token = await tokenFor();
    await exchange(auth, token, "api:read");
    expect(count()).toBe(1);
    // The stored token carries both granted scopes, so a request for both is a hit.
    await exchange(auth, token, "api:read api:write");
    expect(count()).toBe(1);
    // A request for the narrower set is not an exact match of the granted scopes.
    await exchange(auth, token, "api:read");
    expect(count()).toBe(2);
    documented("TokenCaching.md", "The scope comparison uses the scopes the tenant granted, not the ones the tool requested.");
  });
});

describe("TokenCaching.md: scope matching", () => {
  it("reuses a token that covers the request in non_strict mode and exchanges again in strict mode", async () => {
    const strict = adapter({ tokenStore: new MemoryIndexedTokenStore() });
    const token = await tokenFor();
    await exchange(strict, token, "api:read api:write");
    await exchange(strict, token, "api:read");
    expect(count()).toBe(2);

    rig().tenant.auth0.state.reset();
    const loose = adapter({ tokenStore: new MemoryIndexedTokenStore(), scopeMatching: "non_strict" });
    await exchange(loose, token, "api:read api:write");
    await exchange(loose, token, "api:read");
    expect(count()).toBe(1);
    documented(
      "TokenCaching.md",
      "With `\"non_strict\"`, a call for `api:read` reuses a token the tenant issued for `api:read api:write`. With `\"strict\"` it exchanges again.",
      '| `"strict"` (default) | Its granted scopes are exactly the requested scopes. |',
      '| `"non_strict"` | Its granted scopes cover the requested scopes. The smallest such token wins. |',
    );
  });

  it("prefers the smallest covering token", async () => {
    const auth = adapter({ tokenStore: new MemoryIndexedTokenStore(), scopeMatching: "non_strict" });
    const token = await tokenFor();
    const small = await exchange(auth, token, "api:read api:write");
    // The first token does not cover this request, so it takes a second exchange.
    const big = await exchange(auth, token, "api:read api:write api:admin");
    expect(count()).toBe(2);
    const hit = await exchange(auth, token, "api:read");
    expect(count()).toBe(2);
    expect(hit.accessToken).toBe(small.accessToken);
    expect(hit.accessToken).not.toBe(big.accessToken);
  });

  it("throws InvalidConfigurationError when non_strict has no indexed store", () => {
    const plain = new Map<string, CachedToken>();
    const store: TokenStore = {
      get: async (key) => plain.get(key),
      set: async (key, value) => void plain.set(key, value),
      delete: async (key) => void plain.delete(key),
    };
    expect(() => adapter({ tokenStore: store, scopeMatching: "non_strict" })).toThrow(InvalidConfigurationError);
    expect(() => adapter({ scopeMatching: "non_strict" })).toThrow(InvalidConfigurationError);
    expect(() => adapter({ tokenStore: new MemoryIndexedTokenStore(), scopeMatching: "non_strict" })).not.toThrow();
    documented("TokenCaching.md", "`\"non_strict\"` needs a store that supports an index. `MemoryIndexedTokenStore` does.");
  });

  it("builds the adapter of the guide's non_strict block", async () => {
    const loaded = await withEnv({ AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: AUDIENCE, AUTH0_CLIENT_ID: "mcp-client", AUTH0_CLIENT_SECRET: "secret" }, () =>
      loadSnippet("TokenCaching.md", 3, { exportNames: ["auth"] }),
    );
    try {
      const auth = loaded.exports["auth"] as FastMcpAuth;
      const token = await tokenFor();
      await exchange(auth, token, "api:read api:write");
      await exchange(auth, token, "api:read");
      expect(count()).toBe(1);
    } finally {
      loaded.dispose();
    }
  });
});

describe("TokenCaching.md: the reference store", () => {
  it("bounds the number of entries and evicts the least recently used one", async () => {
    const auth = adapter({ tokenStore: new MemoryIndexedTokenStore({ maxEntries: 2 }) });
    const a = await tokenFor({ sub: "user|a" });
    const b = await tokenFor({ sub: "user|b" });
    const c = await tokenFor({ sub: "user|c" });
    await exchange(auth, a);
    await exchange(auth, b);
    expect(count()).toBe(2);
    await exchange(auth, a); // a is now the most recently used
    expect(count()).toBe(2);
    await exchange(auth, c); // evicts b, the least recently used
    expect(count()).toBe(3);
    await exchange(auth, a);
    expect(count()).toBe(3);
    await exchange(auth, b);
    expect(count()).toBe(4);
    documented("TokenCaching.md", "bounds their number (`maxEntries`, with the least recently used entry evicted first)");
  });

  it("is not shared between two stores, so two instances exchange separately", async () => {
    const token = await tokenFor();
    const one = adapter({ tokenStore: new MemoryIndexedTokenStore() });
    const two = adapter({ tokenStore: new MemoryIndexedTokenStore() });
    await exchange(one, token);
    await exchange(two, token);
    expect(count()).toBe(2);

    rig().tenant.auth0.state.reset();
    const shared = new MemoryIndexedTokenStore();
    await exchange(adapter({ tokenStore: shared }), token);
    await exchange(adapter({ tokenStore: shared }), token);
    expect(count()).toBe(1);
    documented(
      "TokenCaching.md",
      "Because it lives in one process, two server instances do not share it, and a restart empties it.",
    );
  });
});

describe("TokenCaching.md: several instances", () => {
  it("keeps access tokens out of the inner store and still reuses them, as the guide's encrypted block does", async () => {
    const seen: string[] = [];
    const inner = new MemoryIndexedTokenStore();
    const spy: IndexedTokenStore = {
      get: (key) => inner.get(key),
      set: async (key, value) => {
        seen.push(JSON.stringify(value));
        await inner.set(key, value);
      },
      delete: (key) => inner.delete(key),
      addIndexMember: async (indexKey, member) => {
        seen.push(JSON.stringify(member));
        await inner.addIndexMember(indexKey, member);
      },
      listIndexMembers: (indexKey) => inner.listIndexMembers(indexKey),
    };
    const secret = "0123456789abcdef0123456789abcdef";
    const auth = adapter({ tokenStore: createEncryptedTokenStore(spy, { secret }), scopeMatching: "non_strict" });
    const token = await tokenFor();
    const first = await exchange(auth, token, "api:read api:write");
    const second = await exchange(auth, token, "api:read");
    expect(count()).toBe(1);
    expect(second.accessToken).toBe(first.accessToken);
    expect(seen.length).toBeGreaterThan(0);
    for (const written of seen) expect(written).not.toContain(first.accessToken);
    documented("TokenCaching.md", "The wrapper encrypts every value before it reaches the inner store, so the shared storage never holds an access token in the clear.");
  });

  it("runs the guide's encrypted block as written", async () => {
    const loaded = await withEnv(
      {
        AUTH0_DOMAIN: DOMAIN,
        AUTH0_AUDIENCE: AUDIENCE,
        AUTH0_CLIENT_ID: "mcp-client",
        AUTH0_CLIENT_SECRET: "secret",
        TOKEN_STORE_SECRET: "0123456789abcdef0123456789abcdef",
      },
      () => loadSnippet("TokenCaching.md", 4, { exportNames: ["auth"] }),
    );
    try {
      const auth = loaded.exports["auth"] as FastMcpAuth;
      const token = await tokenFor();
      await exchange(auth, token, "api:read api:write");
      await exchange(auth, token, "api:read");
      expect(count()).toBe(1);
    } finally {
      loaded.dispose();
    }
  });

  it("refuses a secret shorter than 32 characters", () => {
    expect(() => createEncryptedTokenStore(new MemoryIndexedTokenStore(), { secret: "too-short" })).toThrow(InvalidConfigurationError);
    expect(() => createEncryptedTokenStore(new MemoryIndexedTokenStore(), { secret: "x".repeat(31) })).toThrow(InvalidConfigurationError);
    expect(() => createEncryptedTokenStore(new MemoryIndexedTokenStore(), { secret: "x".repeat(32) })).not.toThrow();
    documented("TokenCaching.md", "The secret must be at least 32 characters");
  });

  it("accepts a client built with the store, as the guide's second block does", () => {
    const client = createMcpClient({ domain: DOMAIN, audience: AUDIENCE, tokenStore: new MemoryIndexedTokenStore() });
    expect(() => createFastMcpAuth({ client })).not.toThrow();
  });
});
