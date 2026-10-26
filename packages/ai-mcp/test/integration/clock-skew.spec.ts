import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import {
  WIRINGS,
  buildToolServer,
  connectClient,
  createRig,
  delegateOnce,
  makeMcpClient,
  startApp,
} from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

const LEEWAY = 5;
const DAY = 86_400;
const START = new Date("2030-01-01T00:00:00Z");

// Only `Date` is faked, so sockets, timers and promises behave normally while every expiry
// calculation reads a fixed, controllable clock.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe.each(WIRINGS)("expiry handling (%s wiring)", (wiring) => {
  async function serve() {
    const { tenant } = rig();
    rig().useTenant();
    return startApp(wiring, tenant, {
      client: makeMcpClient(tenant, { tokenStore: new MemoryIndexedTokenStore() }),
      createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
    });
  }

  async function exchangesAfter(expiresIn: number, advanceSeconds: number): Promise<number> {
    vi.setSystemTime(START);
    const app = await serve();
    try {
      rig().tenant.auth0.state.expiresIn = expiresIn;
      const bearer = await rig().token({ expiresIn: 2 * DAY });
      await delegateOnce(app, bearer);
      vi.setSystemTime(new Date(START.getTime() + advanceSeconds * 1000));
      await delegateOnce(app, bearer);
      return rig().tenant.auth0.state.successfulExchangeCount;
    } finally {
      await app.stop();
    }
  }

  it("reuses a cached token that is comfortably valid", async () => {
    expect(await exchangesAfter(3600, 0)).toBe(1);
  });

  it("reuses a cached token one second outside the leeway", async () => {
    expect(await exchangesAfter(LEEWAY + 1, 0)).toBe(1);
  });

  it("does not reuse a cached token one second inside the leeway", async () => {
    expect(await exchangesAfter(LEEWAY - 1, 0)).toBe(2);
  });

  it("does not reuse a cached token exactly at the leeway", async () => {
    expect(await exchangesAfter(LEEWAY, 0)).toBe(2);
  });

  it("stops reusing a cached token as time passes into its leeway window", async () => {
    expect(await exchangesAfter(3600, 3600 - LEEWAY - 1)).toBe(1);
    rig().reset();
    expect(await exchangesAfter(3600, 3600 - LEEWAY + 1)).toBe(2);
  });

  it("rejects an expired subject token before any exchange", async () => {
    const app = await serve();
    try {
      const expired = await rig().token({ exp: nowSeconds() - 120 });

      await expect(connectClient(app, expired)).rejects.toMatchObject({ code: 401 });
      expect(rig().tenant.auth0.state.exchangeCount).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it("does not exchange a subject token that is about to expire", async () => {
    const app = await serve();
    try {
      // Still accepted at ingress, but inside the leeway the exchange treats it as expired.
      const soon = await rig().token({ exp: nowSeconds() + LEEWAY - 1, sub: "user|soon" });

      await expect(delegateOnce(app, soon)).rejects.toThrow(/delegate failed/);
      expect(rig().tenant.auth0.state.exchangeCount).toBe(0);
      expect(rig().tenant.oracle.calls).toHaveLength(0);
    } finally {
      await app.stop();
    }
  });
});
