import { randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import type {
  CachedToken,
  IndexedTokenStore,
  TokenIndexMember,
  TokenStore,
} from "@auth0/auth0-api-js";
import { createEncryptedTokenStore } from "../../src/stores/encrypted-store.js";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import {
  callToolJson,
  connectMcpClient,
  getUserToken,
  installFetchCounter,
  loadE2eEnv,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type {
  DelegateResult,
  DownstreamApi,
  E2eMcpServer,
  FetchCounter,
} from "./support/index.js";

const e2e = loadE2eEnv();

/**
 * An indexed store that wraps a real one and remembers every raw value written to it, so a spec
 * can look at exactly what a backing store was handed (plaintext or ciphertext).
 */
class SpyStore implements IndexedTokenStore {
  readonly inner = new MemoryIndexedTokenStore();
  readonly writes: { key: string; value: CachedToken }[] = [];
  readonly members: { indexKey: string; member: TokenIndexMember }[] = [];

  get size(): number {
    return this.inner.size;
  }
  get(key: string) {
    return this.inner.get(key);
  }
  set(key: string, value: CachedToken) {
    this.writes.push({ key, value: structuredClone(value) });
    return this.inner.set(key, value);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  addIndexMember(indexKey: string, member: TokenIndexMember) {
    this.members.push({ indexKey, member: structuredClone(member) });
    return this.inner.addIndexMember(indexKey, member);
  }
  listIndexMembers(indexKey: string) {
    return this.inner.listIndexMembers(indexKey);
  }
  /** Everything ever written, serialized, for substring checks. */
  dump(): string {
    return JSON.stringify({ writes: this.writes, members: this.members });
  }
}

/** Plain store with no index methods. */
class PlainStore implements TokenStore {
  readonly #map = new Map<string, CachedToken>();
  async get(key: string) {
    return this.#map.get(key);
  }
  async set(key: string, value: CachedToken) {
    this.#map.set(key, value);
  }
  async delete(key: string) {
    this.#map.delete(key);
  }
}

/** Wraps `fetch` to remember the bearer sent to the downstream API. Nothing is logged. */
function captureBearers(downstreamUrl: string) {
  const original = globalThis.fetch;
  const bearers: string[] = [];
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    if (url === downstreamUrl) {
      const header = new Headers(init?.headers).get("authorization") ?? "";
      const token = /^Bearer (\S+)$/i.exec(header)?.[1];
      if (token !== undefined) bearers.push(token);
    }
    return original(input, init);
  }) as typeof fetch;
  globalThis.fetch = wrapper;
  return {
    bearers,
    restore() {
      if (globalThis.fetch === wrapper) globalThis.fetch = original;
    },
  };
}

const scopesOf = (scope: string | undefined) =>
  (scope ?? "").split(" ").filter(Boolean);

describe("e2e token stores", () => {
  let downstream: DownstreamApi;
  let userToken: string;
  let counter: FetchCounter | undefined;
  let capture: ReturnType<typeof captureBearers> | undefined;
  const servers: E2eMcpServer[] = [];
  const closers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    downstream = await startDownstreamApi({
      domain: e2e.domain,
      audience: e2e.downstreamAudience,
    });
    userToken = await getUserToken(e2e);
  });

  beforeEach(() => {
    counter = installFetchCounter();
    capture = captureBearers(downstream.url);
    downstream.calls.length = 0;
  });

  afterEach(async () => {
    // Restore in reverse order of installation.
    capture?.restore();
    counter?.restore();
    for (const close of closers.splice(0)) await close();
    for (const server of servers.splice(0)) await server.close();
  });

  afterAll(async () => {
    await downstream.close();
  });

  async function open(options: Partial<Parameters<typeof startMcpServer>[0]>) {
    const server = await startMcpServer({
      env: e2e,
      downstreamUrl: downstream.url,
      ...options,
    });
    servers.push(server);
    const session = await connectMcpClient(server.url, userToken);
    closers.push(() => session.close());
    return session;
  }

  async function delegate(
    session: Awaited<ReturnType<typeof open>>,
    scope: string,
  ) {
    const { isError, value } = await callToolJson<DelegateResult>(
      session.client,
      "delegate",
      { scope },
    );
    expect(isError).toBe(false);
    expect(value.status).toBe(200);
    return value;
  }

  const lastClaims = () => downstream.calls.at(-1)?.claims;

  it("non_strict with an indexed store reuses a covering token and exchanges again for an uncovered scope", async () => {
    const session = await open({
      scopeMatching: "non_strict",
      tokenStore: new MemoryIndexedTokenStore(),
    });
    counter!.reset();

    await delegate(session, "work:read");
    expect(counter!.exchanges).toBe(1);

    // work:write is not covered by the stored work:read token, so it exchanges again.
    await delegate(session, "work:read work:write");
    expect(counter!.exchanges).toBe(2);
    expect(scopesOf(lastClaims()?.["scope"] as string | undefined)).toEqual(
      expect.arrayContaining(["work:read", "work:write"]),
    );

    // A narrower request is covered by the stored token that holds both scopes.
    const covered = await delegate(session, "work:write");
    expect(counter!.exchanges).toBe(2);
    expect(covered.grantedScopes).toEqual(
      expect.arrayContaining(["work:read", "work:write"]),
    );
    expect(downstream.calls.map((c) => c.status)).toEqual([200, 200, 200]);
    expect(scopesOf(lastClaims()?.["scope"] as string | undefined)).toContain(
      "work:write",
    );
  });

  it("strict matching does not reuse a token for a narrower scope", async () => {
    const session = await open({
      scopeMatching: "strict",
      tokenStore: new MemoryIndexedTokenStore(),
    });
    counter!.reset();
    await delegate(session, "work:read work:write");
    await delegate(session, "work:read");
    expect(counter!.exchanges).toBe(2);
  });

  it("rejects non_strict with a plain store at construction", async () => {
    await expect(
      startMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        scopeMatching: "non_strict",
        tokenStore: new PlainStore(),
      }),
    ).rejects.toBeInstanceOf(InvalidConfigurationError);
  });

  describe("encrypted store", () => {
    const newSecret = () => randomBytes(32).toString("base64url");

    /** Runs one delegate call and returns the real downstream bearer and the verified claims. */
    async function firstCall(backing: SpyStore, secret: string) {
      const session = await open({
        tokenStore: createEncryptedTokenStore(backing, { secret }),
      });
      counter!.reset();
      capture!.bearers.length = 0;
      await delegate(session, "work:read");
      expect(counter!.exchanges).toBe(1);
      const bearer = capture!.bearers.at(-1)!;
      return { session, bearer, claims: lastClaims()! };
    }

    it("stores only ciphertext, serves the second call from cache and decrypts to the real token", async () => {
      const backing = new SpyStore();
      const secret = newSecret();
      const { session, bearer, claims } = await firstCall(backing, secret);

      expect(backing.size).toBeGreaterThanOrEqual(1);
      expect(backing.writes.length).toBeGreaterThanOrEqual(1);

      const dump = backing.dump();
      const parts = bearer.split(".");
      expect(parts.length, "bearer must be a three-segment JWT").toBe(3);
      expect(
        dump.includes(bearer),
        "store dump must not contain the bearer",
      ).toBe(false);
      for (const part of parts)
        expect(
          dump.includes(part),
          "store dump must not contain a bearer segment",
        ).toBe(false);
      expect(typeof claims.sub).toBe("string");
      expect(dump.includes(claims.sub!), "store dump must not contain the subject").toBe(false);
      expect(dump.includes(encodeURIComponent(claims.sub!)), "store dump must not contain the encoded subject").toBe(false);
      // The stored envelope is a compact JWE (five segments), not a JWT (three).
      for (const { value } of backing.writes)
        expect(
          value.accessToken.split(".").length,
          "stored token must be a five-segment JWE",
        ).toBe(5);

      // Second call: served from cache, downstream verifies the decrypted token.
      downstream.calls.length = 0;
      await delegate(session, "work:read");
      expect(counter!.exchanges).toBe(1);
      expect(downstream.calls.map((c) => c.status)).toEqual([200]);
      expect(
        capture!.bearers.at(-1) === bearer,
        "downstream must receive the cached bearer",
      ).toBe(true);

      // Public read-back through the wrapper with the same secret yields the real token.
      const reader = createEncryptedTokenStore(backing, { secret });
      const stored = await reader.get(backing.writes[0]!.key);
      expect(stored?.accessToken === bearer).toBe(true);
    });

    it("a second server on the same backing store and the same key reuses the entry", async () => {
      const backing = new SpyStore();
      const secret = newSecret();
      const { bearer } = await firstCall(backing, secret);

      const second = await open({
        tokenStore: createEncryptedTokenStore(backing, { secret }),
      });
      counter!.reset();
      downstream.calls.length = 0;
      await delegate(second, "work:read");
      expect(counter!.exchanges).toBe(0);
      expect(downstream.calls.map((c) => c.status)).toEqual([200]);
      expect(
        capture!.bearers.at(-1) === bearer,
        "downstream must receive the cached bearer",
      ).toBe(true);
    });

    it("a different key is a cache miss that leads to a fresh exchange and leaks no plaintext", async () => {
      const backing = new SpyStore();
      const { bearer, claims } = await firstCall(backing, newSecret());

      const other = await open({
        tokenStore: createEncryptedTokenStore(backing, { secret: newSecret() }),
      });
      counter!.reset();
      downstream.calls.length = 0;
      await delegate(other, "work:read");
      // Reads fail open: the undecryptable entry is a miss, so a new exchange happens.
      expect(counter!.exchanges).toBe(1);
      expect(downstream.calls.map((c) => c.status)).toEqual([200]);

      const dump = backing.dump();
      expect(
        dump.includes(bearer),
        "store dump must not contain the bearer",
      ).toBe(false);
      const fresh = capture!.bearers.at(-1)!;
      expect(dump.includes(fresh)).toBe(false);
      for (const part of fresh.split("."))
        expect(
          dump.includes(part),
          "store dump must not contain a bearer segment",
        ).toBe(false);
      expect(dump.includes(claims.sub!), "store dump must not contain the subject").toBe(false);
    });
  });

  it("stores an entry whose expiry matches the real token's exp", async () => {
    const backing = new SpyStore();
    const session = await open({ tokenStore: backing });
    counter!.reset();
    await delegate(session, "work:read");

    const exp = lastClaims()?.exp;
    expect(typeof exp).toBe("number");
    expect(backing.writes.length).toBeGreaterThanOrEqual(1);
    const entry = await backing.get(backing.writes[0]!.key);
    expect(entry).toBeDefined();
    // expiresAt is epoch seconds, computed from expires_in at exchange time.
    expect(Math.abs(entry!.expiresAt - (exp as number))).toBeLessThanOrEqual(5);
    expect(entry!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
