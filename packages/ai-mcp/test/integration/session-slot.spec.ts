import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import { WIRINGS, buildToolServer, createRig, delegateOnce, makeMcpClient, startApp } from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

describe.each(WIRINGS)("session slot in the cache key (%s wiring)", (wiring) => {
  async function serve(store?: MemoryIndexedTokenStore) {
    const { tenant } = rig();
    rig().useTenant();
    return startApp(wiring, tenant, {
      client: makeMcpClient(tenant, store ? { tokenStore: store } : {}),
      createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
    });
  }

  const same = { sub: "user|1", claims: { client_id: "client-a" } };

  it("serves the same session from the cache", async () => {
    const store = new MemoryIndexedTokenStore();
    const app = await serve(store);
    try {
      const bearer = await rig().token({ ...same, claims: { ...same.claims, sid: "session-1" } });
      await delegateOnce(app, bearer);
      await delegateOnce(app, bearer);

      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it("does not share a cached token between two sessions of the same subject", async () => {
    const store = new MemoryIndexedTokenStore();
    const app = await serve(store);
    try {
      const one = await rig().token({ ...same, claims: { ...same.claims, sid: "session-1" } });
      const two = await rig().token({ ...same, claims: { ...same.claims, sid: "session-2" } });
      const first = await delegateOnce(app, one);
      const second = await delegateOnce(app, two);
      await delegateOnce(app, one);
      await delegateOnce(app, two);

      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(2);
      expect(store.size).toBe(2);
      expect(second.body.jti).not.toBe(first.body.jti);
      rig().assertAllForwardedTokensVerified();
    } finally {
      await app.stop();
    }
  });

  it("does not merge concurrent exchanges of two sessions", async () => {
    const app = await serve();
    try {
      const one = await rig().token({ ...same, claims: { ...same.claims, sid: "session-1" } });
      const two = await rig().token({ ...same, claims: { ...same.claims, sid: "session-2" } });
      await Promise.all([delegateOnce(app, one), delegateOnce(app, two)]);

      expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it("keys on the session id first: different tokens in one session share an entry", async () => {
    const store = new MemoryIndexedTokenStore();
    const app = await serve(store);
    try {
      const claims = { ...same.claims, sid: "session-1" };
      const one = await rig().token({ ...same, claims, jti: "token-1", iat: 1_700_000_000 });
      const two = await rig().token({ ...same, claims, jti: "token-2", iat: 1_700_000_100 });
      expect(one).not.toBe(two);
      await delegateOnce(app, one);
      await delegateOnce(app, two);

      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(1);
      expect(store.size).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it("keys on the session id over the token id: one token id in two sessions does not share", async () => {
    const store = new MemoryIndexedTokenStore();
    const app = await serve(store);
    try {
      const one = await rig().token({ ...same, claims: { ...same.claims, sid: "session-1" }, jti: "token-1" });
      const two = await rig().token({ ...same, claims: { ...same.claims, sid: "session-2" }, jti: "token-1" });
      await delegateOnce(app, one);
      await delegateOnce(app, two);

      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(2);
      expect(store.size).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it("falls back to a digest of the token when there is neither session id nor token id", async () => {
    const store = new MemoryIndexedTokenStore();
    const app = await serve(store);
    try {
      const one = await rig().token({ ...same, iat: 1_700_000_000 });
      const two = await rig().token({ ...same, iat: 1_700_000_100 });
      await delegateOnce(app, one);
      await delegateOnce(app, one);
      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(1);

      await delegateOnce(app, two);
      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(2);
      expect(store.size).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it("falls back to the token id when the token carries no session id", async () => {
    const store = new MemoryIndexedTokenStore();
    const app = await serve(store);
    try {
      const one = await rig().token({ ...same, jti: "token-1" });
      const two = await rig().token({ ...same, jti: "token-2" });
      await delegateOnce(app, one);
      await delegateOnce(app, two);
      await delegateOnce(app, one);

      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(2);
    } finally {
      await app.stop();
    }
  });
});
