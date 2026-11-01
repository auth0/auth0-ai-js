/**
 * What an infrastructure failure in the token store looks like from the outside.
 *
 * A store whose reads and writes throw is driven through the whole stack: a real SDK client, the
 * handler, the request-scoped client and the core cache. Every test pins the behaviour as it is
 * today: a failing store never fails a tool call, a failed read is a miss, a failed write is
 * dropped, nothing the store said reaches the client, and the cache works again as soon as the
 * store does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedToken, IndexedTokenStore, TokenIndexMember } from "@auth0/auth0-api-js";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import {
  WIRINGS,
  buildToolServer,
  connectClient,
  createBarrier,
  createRig,
  makeMcpClient,
  startApp,
} from "./harness.js";
import type { App, DelegateOutcome, Wiring } from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

type Operation = "get" | "set" | "delete" | "addIndexMember" | "listIndexMembers";

/** Text a leaked store error would carry. It looks like the connection string of a real outage. */
const STORE_SECRET = "redis://cache-user:hunter2@cache.internal:6379";
const STORE_MESSAGE = `STORE_BOOM connect ECONNREFUSED ${STORE_SECRET}`;

/** An indexed in-memory store whose operations can be made to throw, and which counts its calls. */
class FaultyStore implements IndexedTokenStore {
  readonly inner = new MemoryIndexedTokenStore();
  readonly calls: Record<Operation, number> = { get: 0, set: 0, delete: 0, addIndexMember: 0, listIndexMembers: 0 };
  readonly #failing = new Set<Operation>();

  fail(...operations: Operation[]): void {
    for (const operation of operations) this.#failing.add(operation);
  }

  heal(): void {
    this.#failing.clear();
  }

  #enter(operation: Operation): void {
    this.calls[operation]++;
    if (this.#failing.has(operation)) {
      const error = new Error(STORE_MESSAGE);
      error.stack = `Error: ${STORE_MESSAGE}\n    at storeInternals (/srv/secret/path/redis-client.js:1:1)`;
      throw error;
    }
  }

  async get(key: string): Promise<CachedToken | undefined> {
    this.#enter("get");
    return this.inner.get(key);
  }

  async set(key: string, value: CachedToken): Promise<void> {
    this.#enter("set");
    return this.inner.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#enter("delete");
    return this.inner.delete(key);
  }

  async addIndexMember(indexKey: string, member: TokenIndexMember): Promise<void> {
    this.#enter("addIndexMember");
    return this.inner.addIndexMember(indexKey, member);
  }

  async listIndexMembers(indexKey: string): Promise<TokenIndexMember[]> {
    this.#enter("listIndexMembers");
    return this.inner.listIndexMembers(indexKey);
  }
}

const WIDE = "api:read api:write";
const NARROW = "api:read";

describe.each(WIRINGS)("token store failures (%s wiring)", (wiring: Wiring) => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  });

  /** Everything written to the console while a test ran, flattened to one string. */
  function consoleOutput(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(" "))
      .join("\n");
  }

  /** One result as the client saw it, with the raw text kept so leaks can be searched for. */
  interface Seen {
    isError: boolean;
    outcome: DelegateOutcome | undefined;
    raw: string;
  }

  function assertNoStoreDetail(seen: Seen[]): void {
    for (const item of seen) {
      expect(item.raw.includes("STORE_BOOM")).toBe(false);
      expect(item.raw.includes("hunter2")).toBe(false);
      expect(item.raw.includes("ECONNREFUSED")).toBe(false);
      expect(item.raw.includes("redis-client")).toBe(false);
    }
    const logged = consoleOutput();
    expect(logged.includes("STORE_BOOM")).toBe(false);
    expect(logged.includes("hunter2")).toBe(false);
  }

  /**
   * One long-lived `McpClient` (and so one store) served by one app per requested scope, so that
   * calls with different scopes share a cache the way two tools of one server would.
   */
  async function scenario(
    clientOptions: { scopeMatching?: "strict" | "non_strict" },
    body: (ctx: {
      store: FaultyStore;
      /** Runs `delegate` once with the given scope on a fresh MCP session. */
      call(scope: string, bearer?: string): Promise<Seen>;
      /** Runs `count` concurrent identical `delegate` calls on one session. */
      burst(scope: string, count: number): Promise<Seen[]>;
      bearer: string;
    }) => Promise<void>,
  ): Promise<void> {
    const { tenant } = rig();
    rig().useTenant();
    const store = new FaultyStore();
    const client = makeMcpClient(tenant, { tokenStore: store, ...clientOptions });
    const apps = new Map<string, App>();
    const appFor = async (scope: string, barrier?: () => Promise<void>): Promise<App> => {
      const key = `${scope}|${barrier === undefined ? "plain" : "barrier"}`;
      let app = apps.get(key);
      if (app === undefined) {
        app = await startApp(wiring, tenant, {
          client,
          createServer: () =>
            buildToolServer({
              downstreamUrl: tenant.downstreamUrl,
              delegateScope: scope,
              ...(barrier !== undefined && { barrier }),
            }),
        });
        apps.set(key, app);
      }
      return app;
    };
    const bearer = await rig().token({ sub: "user|store-failure" });
    const read = async (session: Awaited<ReturnType<typeof connectClient>>): Promise<Seen> => {
      const result = (await session.client.callTool({ name: "delegate", arguments: {} })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      const raw = result.content.map((part) => part.text).join("\n");
      const isError = result.isError === true;
      let outcome: DelegateOutcome | undefined;
      if (!isError) outcome = JSON.parse(raw) as DelegateOutcome;
      return { isError, outcome, raw };
    };
    try {
      await body({
        store,
        bearer,
        async call(scope, token = bearer) {
          const session = await connectClient(await appFor(scope), token);
          try {
            return await read(session);
          } finally {
            await session.close();
          }
        },
        async burst(scope, count) {
          let barrier = createBarrier(count);
          const app = await appFor(scope, () => barrier());
          barrier = createBarrier(count);
          const session = await connectClient(app, bearer);
          try {
            return await Promise.all(Array.from({ length: count }, () => read(session)));
          } finally {
            await session.close();
          }
        },
      });
    } finally {
      await Promise.all([...apps.values()].map((app) => app.stop()));
    }
  }

  function expectDelegated(seen: Seen): void {
    expect(seen.isError).toBe(false);
    expect(seen.outcome?.status).toBe(200);
    expect(seen.outcome?.body).toMatchObject({ ok: true, sub: "user|store-failure" });
  }

  describe("strict scope matching", () => {
    it("treats a failing read as a miss: the call succeeds, one exchange per call, nothing leaks", async () => {
      await scenario({}, async ({ store, call }) => {
        store.fail("get");

        const first = await call(NARROW);
        const second = await call(NARROW);

        expectDelegated(first);
        expectDelegated(second);
        // Each call missed, so each exchanged. The write side was healthy, so the token was stored.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
        expect(store.calls.get).toBe(2);
        expect(store.inner.size).toBe(1);
        assertNoStoreDetail([first, second]);
        rig().assertAllForwardedTokensVerified();
      });
    });

    it("serves from the cache again once reads work, without a further exchange", async () => {
      await scenario({}, async ({ store, call }) => {
        store.fail("get");
        await call(NARROW);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);

        store.heal();
        const recovered = await call(NARROW);
        const cached = await call(NARROW);

        expectDelegated(recovered);
        expectDelegated(cached);
        // The entry written during the outage is found on the first healthy read.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        expect(recovered.outcome?.body.jti).toBe(cached.outcome?.body.jti);
      });
    });

    it("returns the freshly exchanged token when the write throws, and does not retry the exchange", async () => {
      await scenario({}, async ({ store, call }) => {
        store.fail("set");

        const result = await call(NARROW);

        expectDelegated(result);
        expect(result.outcome?.body.scopes).toEqual(["api:read"]);
        // Exactly one exchange and exactly one write attempt: a failed write is not retried.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        expect(store.calls.set).toBe(1);
        expect(store.inner.size).toBe(0);
        assertNoStoreDetail([result]);
        rig().assertAllForwardedTokensVerified();
      });
    });

    it("exchanges on every call while writes keep failing, then caches normally once they work", async () => {
      await scenario({}, async ({ store, call }) => {
        store.fail("set");
        const first = await call(NARROW);
        const second = await call(NARROW);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
        expect(store.inner.size).toBe(0);

        store.heal();
        const third = await call(NARROW);
        const fourth = await call(NARROW);

        expectDelegated(third);
        expectDelegated(fourth);
        // One more exchange to fill the cache, then a hit.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(3);
        expect(store.inner.size).toBe(1);
        expect(third.outcome?.body.jti).toBe(fourth.outcome?.body.jti);
        assertNoStoreDetail([first, second, third, fourth]);
      });
    });

    it("survives a store where every operation throws", async () => {
      await scenario({}, async ({ store, call }) => {
        store.fail("get", "set", "delete", "addIndexMember", "listIndexMembers");

        const first = await call(NARROW);
        const second = await call(NARROW);

        expectDelegated(first);
        expectDelegated(second);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
        assertNoStoreDetail([first, second]);
      });
    });

    it("gives 5 concurrent callers one consistent success and one exchange when the write throws", async () => {
      await scenario({}, async ({ store, burst }) => {
        store.fail("set");

        const results = await burst(NARROW, 5);

        expect(results).toHaveLength(5);
        for (const result of results) expectDelegated(result);
        expect(new Set(results.map((r) => r.outcome?.body.jti)).size).toBe(1);
        // Single-flight collapses the burst, so the broken write is attempted once, not five times.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        expect(store.calls.set).toBe(1);
        assertNoStoreDetail(results);
      });
    });

    it("gives 5 concurrent callers one consistent success and one exchange when the read throws", async () => {
      await scenario({}, async ({ store, burst }) => {
        store.fail("get");

        const results = await burst(NARROW, 5);

        for (const result of results) expectDelegated(result);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        assertNoStoreDetail(results);
      });
    });

    it("never calls delete, so a store whose delete throws has no effect", async () => {
      await scenario({}, async ({ store, call }) => {
        store.fail("delete");

        const first = await call(NARROW);
        const second = await call(NARROW);

        expectDelegated(first);
        expectDelegated(second);
        expect(store.calls.delete).toBe(0);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
      });
    });

    it("does not touch the index at all in strict mode", async () => {
      await scenario({}, async ({ store, call }) => {
        store.fail("addIndexMember", "listIndexMembers");

        const result = await call(NARROW);
        const cached = await call(NARROW);

        expectDelegated(result);
        expectDelegated(cached);
        expect(store.calls.addIndexMember).toBe(0);
        expect(store.calls.listIndexMembers).toBe(0);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
      });
    });
  });

  describe("non_strict scope matching", () => {
    it("treats a failing index read as a miss: the call succeeds, no stale or partial reuse, nothing leaks", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        const wide = await call(WIDE);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);

        store.fail("listIndexMembers");
        const narrow = await call(NARROW);

        expectDelegated(wide);
        expectDelegated(narrow);
        // The wide entry could have covered the narrow request, but the index could not be read.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
        expect(narrow.outcome?.body.jti).not.toBe(wide.outcome?.body.jti);
        assertNoStoreDetail([wide, narrow]);
        rig().assertAllForwardedTokensVerified();
      });
    });

    it("reuses the covering entry again once the index can be read", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        const wide = await call(WIDE);
        store.fail("listIndexMembers");
        await call(NARROW);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);

        store.heal();
        const recovered = await call(NARROW);

        expectDelegated(recovered);
        // The narrow request is served from a cached entry again (the closest covering one).
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
        expect(wide.outcome?.body.scopes).toEqual(["api:read", "api:write"]);
      });
    });

    it("returns the exchanged token when the index write throws, and does not retry the exchange", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        store.fail("addIndexMember");

        const result = await call(WIDE);

        expectDelegated(result);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        expect(store.calls.set).toBe(1);
        expect(store.calls.addIndexMember).toBe(1);
        assertNoStoreDetail([result]);
      });
    });

    // PINNED CURRENT BEHAVIOUR, LOOKS WRONG (reported as a finding): the core cache writes the
    // token first and the index member second, and ignores a failure of the second step. The
    // token is left in the store without an index member. Non-strict lookups go through the
    // index only, so that token can never be found, not even by an identical request. A one-off
    // index write failure therefore costs one exchange per orphaned entry, silently.
    it("leaves the token unreachable after an index write failure, even for the identical request", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        store.fail("addIndexMember");
        await call(WIDE);
        store.heal();

        const again = await call(WIDE);

        expectDelegated(again);
        expect(store.inner.size).toBeGreaterThanOrEqual(1);
        // The identical request exchanged again instead of finding the token that was stored.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
      });
    });

    it("indexes normally once writes work again, and then serves covered requests from the cache", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        store.fail("addIndexMember");
        await call(WIDE);
        store.heal();
        await call(WIDE);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);

        const narrow = await call(NARROW);
        const wideAgain = await call(WIDE);

        expectDelegated(narrow);
        expectDelegated(wideAgain);
        // The second wide exchange was indexed, so both later requests are covered by it.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
      });
    });

    it("returns the exchanged token when the token write throws before the index is touched", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        store.fail("set");

        const result = await call(WIDE);

        expectDelegated(result);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        // The index write is skipped when the token write fails, so nothing dangling is indexed.
        expect(store.calls.addIndexMember).toBe(0);
        expect(store.inner.size).toBe(0);
      });
    });

    it("does not read tokens by key in non_strict mode when only the entry read fails", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        await call(WIDE);
        store.fail("get");

        const narrow = await call(NARROW);

        expectDelegated(narrow);
        // The index pointed at a covering entry, but reading it failed: a miss, so a new exchange.
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
        assertNoStoreDetail([narrow]);
      });
    });

    it("gives 5 concurrent callers one consistent success when index and token writes throw", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, burst }) => {
        store.fail("set", "addIndexMember", "listIndexMembers");

        const results = await burst(WIDE, 5);

        for (const result of results) expectDelegated(result);
        expect(new Set(results.map((r) => r.outcome?.body.jti)).size).toBe(1);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        assertNoStoreDetail(results);
      });
    });

    it("never calls delete in non_strict mode either", async () => {
      await scenario({ scopeMatching: "non_strict" }, async ({ store, call }) => {
        store.fail("delete");

        await call(WIDE);
        await call(NARROW);

        expect(store.calls.delete).toBe(0);
      });
    });
  });

  it("forwards a token the downstream API verified when both reads and writes throw", async () => {
    await scenario({}, async ({ store, call }) => {
      store.fail("get", "set");

      const result = await call(NARROW);

      expectDelegated(result);
      expect(rig().tenant.oracle.calls).toHaveLength(1);
    });
  });
});
