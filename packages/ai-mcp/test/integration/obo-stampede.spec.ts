import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import {
  WIRINGS,
  buildToolServer,
  callJson,
  connectClient,
  createBarrier,
  createRig,
  makeMcpClient,
  withApp,
} from "./harness.js";
import type { DelegateOutcome } from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

const CALLERS = 8;

describe.each(WIRINGS)("concurrent identical exchanges (%s wiring)", (wiring) => {
  async function stampede(
    options: { store?: MemoryIndexedTokenStore },
    scenario: (run: () => Promise<Array<{ isError: boolean; value: DelegateOutcome | string }>>) => Promise<void>,
  ) {
    const { tenant } = rig();
    rig().useTenant();
    let barrier = createBarrier(CALLERS);
    await withApp(
      wiring,
      tenant,
      {
        client: makeMcpClient(tenant, options.store ? { tokenStore: options.store } : {}),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl, barrier: () => barrier() }),
      },
      async (app) => {
        const bearer = await rig().token({ sub: "user|stampede" });
        const session = await connectClient(app, bearer);
        try {
          await scenario(async () => {
            barrier = createBarrier(CALLERS);
            return Promise.all(
              Array.from({ length: CALLERS }, () => callJson<DelegateOutcome | string>(session, "delegate")),
            );
          });
        } finally {
          await session.close();
        }
      },
    );
  }

  it("performs one exchange for concurrent identical calls and hands every caller a verified token", async () => {
    await stampede({}, async (run) => {
      const results = await run();

      expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
      expect(results).toHaveLength(CALLERS);
      for (const result of results) {
        const outcome = result.value as DelegateOutcome;
        expect(result.isError).toBe(false);
        expect(outcome.status).toBe(200);
        expect(outcome.body).toMatchObject({ ok: true, sub: "user|stampede", scopes: ["api:read"] });
      }
      expect(new Set(results.map((r) => (r.value as DelegateOutcome).body.jti)).size).toBe(1);
      expect(rig().tenant.oracle.calls).toHaveLength(CALLERS);
      rig().assertAllForwardedTokensVerified();
    });
  });

  it("performs one exchange when a store is configured too", async () => {
    const store = new MemoryIndexedTokenStore();
    await stampede({ store }, async (run) => {
      await run();

      expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
      expect(store.size).toBe(1);
    });
  });

  it("shares a failed exchange between the waiting calls but does not remember it", async () => {
    await stampede({}, async (run) => {
      rig().tenant.auth0.state.failure = { status: 500, body: { error: "server_error" } };
      rig().tenant.auth0.state.failureDelayMs = 50;
      const failed = await run();

      expect(failed.every((r) => r.isError)).toBe(true);
      expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(0);

      rig().tenant.auth0.state.failure = null;
      const recovered = await run();

      expect(recovered.every((r) => !r.isError)).toBe(true);
      expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(1);
      rig().assertAllForwardedTokensVerified();
    });
  });

  it("does not cache a failed exchange in the store", async () => {
    const store = new MemoryIndexedTokenStore();
    await stampede({ store }, async (run) => {
      rig().tenant.auth0.state.failure = { status: 500, body: { error: "server_error" } };
      await run();

      expect(store.size).toBe(0);

      rig().tenant.auth0.state.failure = null;
      await run();

      expect(store.size).toBe(1);
      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(1);
    });
  });
});
