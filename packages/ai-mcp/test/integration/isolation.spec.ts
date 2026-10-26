import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import type { Tenant } from "./harness.js";
import {
  WIRINGS,
  buildToolServer,
  createRig,
  delegateOnce,
  makeMcpClient,
  startApp,
} from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

function serverFor(tenant: Tenant) {
  return () => buildToolServer({ downstreamUrl: tenant.downstreamUrl });
}

describe.each(WIRINGS)("cache and exchange isolation (%s wiring)", (wiring) => {
  it("reuses a cached token for the same caller, which makes the isolation cases below meaningful", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const app = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant, { tokenStore: new MemoryIndexedTokenStore() }),
      createServer: serverFor(tenant),
    });
    try {
      const bearer = await rig().token({ sub: "user|same" });
      const first = await delegateOnce(app, bearer);
      const second = await delegateOnce(app, bearer);

      expect(tenant.auth0.state.successfulExchangeCount).toBe(1);
      expect(second.body.jti).toBe(first.body.jti);
    } finally {
      await app.stop();
    }
  });

  it("never shares a token between different subjects, organizations or caller clients", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const app = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant, { tokenStore: new MemoryIndexedTokenStore() }),
      createServer: serverFor(tenant),
    });
    try {
      const callers = [
        { sub: "user|a", claims: { client_id: "client-a" } },
        { sub: "user|b", claims: { client_id: "client-a" } },
        { sub: "user|a", claims: { client_id: "client-a", org_id: "org_1" } },
        { sub: "user|a", claims: { client_id: "client-a", org_id: "org_2" } },
        { sub: "user|a", claims: { client_id: "client-b" } },
      ];
      const tokens = await Promise.all(callers.map((c) => rig().token(c)));

      const jtis = new Set<string | undefined>();
      for (let round = 0; round < 2; round++) {
        for (const [index, bearer] of tokens.entries()) {
          const outcome = await delegateOnce(app, bearer);
          const expected = callers[index]!;
          expect(outcome.body.sub).toBe(expected.sub);
          expect(outcome.body.orgId).toBe((expected.claims as { org_id?: string }).org_id ?? null);
          jtis.add(outcome.body.jti);
        }
      }

      expect(tenant.auth0.state.successfulExchangeCount).toBe(callers.length);
      expect(jtis.size).toBe(callers.length);
      rig().assertAllForwardedTokensVerified();
    } finally {
      await app.stop();
    }
  });

  it("keeps subjects, organizations and caller clients apart even when their session ids collide", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const app = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant, { tokenStore: new MemoryIndexedTokenStore() }),
      createServer: serverFor(tenant),
    });
    try {
      const callers = [
        { sub: "user|a", claims: { client_id: "client-a", sid: "shared" } },
        { sub: "user|b", claims: { client_id: "client-a", sid: "shared" } },
        { sub: "user|a", claims: { client_id: "client-a", sid: "shared", org_id: "org_1" } },
        { sub: "user|a", claims: { client_id: "client-b", sid: "shared" } },
      ];
      const tokens = await Promise.all(callers.map((c) => rig().token(c)));

      for (let round = 0; round < 2; round++) {
        for (const [index, bearer] of tokens.entries()) {
          const outcome = await delegateOnce(app, bearer);
          expect(outcome.body.sub).toBe(callers[index]!.sub);
          expect(outcome.body.orgId).toBe((callers[index]!.claims as { org_id?: string }).org_id ?? null);
        }
      }

      expect(tenant.auth0.state.successfulExchangeCount).toBe(callers.length);
    } finally {
      await app.stop();
    }
  });

  it("never shares a token between servers whose exchanging client ids differ", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const store = new MemoryIndexedTokenStore();
    const a = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant, { clientId: "mcp-client-a", tokenStore: store }),
      createServer: serverFor(tenant),
    });
    const b = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant, { clientId: "mcp-client-b", tokenStore: store }),
      createServer: serverFor(tenant),
    });
    try {
      const bearer = await rig().token({ sub: "user|shared" });
      for (let round = 0; round < 2; round++) {
        await delegateOnce(a, bearer);
        await delegateOnce(b, bearer);
      }

      expect(tenant.auth0.state.successfulExchangeCount).toBe(2);
      const ids = tenant.auth0.state.requests.map((r) => r.clientId);
      expect(new Set(ids)).toEqual(new Set(["mcp-client-a", "mcp-client-b"]));
      expect(store.size).toBe(2);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("never shares a token between servers that trust different issuers", async () => {
    const { tenant } = rig();
    const other = await rig().addTenant("other.example.com");
    rig().useTenant(tenant);
    rig().useTenant(other);
    const store = new MemoryIndexedTokenStore();
    const a = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant, { tokenStore: store }),
      createServer: serverFor(tenant),
    });
    const b = await startApp(wiring, other, {
      client: makeMcpClient(other, { tokenStore: store }),
      createServer: serverFor(other),
    });
    try {
      // Same subject and client id at both issuers.
      const tokenA = await rig().token({ sub: "user|same", tenant });
      const tokenB = await rig().token({ sub: "user|same", tenant: other });
      for (let round = 0; round < 2; round++) {
        await delegateOnce(a, tokenA);
        await delegateOnce(b, tokenB);
      }

      expect(tenant.auth0.state.successfulExchangeCount).toBe(1);
      expect(other.auth0.state.successfulExchangeCount).toBe(1);
      expect(store.size).toBe(2);
      // Each downstream accepted only tokens from its own issuer.
      expect(tenant.oracle.calls).toHaveLength(2);
      expect(other.oracle.calls).toHaveLength(2);
      rig().assertAllForwardedTokensVerified();
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("does not let one tenant's server accept a token issued by another tenant", async () => {
    const { tenant } = rig();
    const other = await rig().addTenant("other.example.com");
    rig().useTenant(tenant);
    rig().useTenant(other);
    const app = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant),
      createServer: serverFor(tenant),
    });
    try {
      await expect(delegateOnce(app, await rig().token({ tenant: other }))).rejects.toMatchObject({ code: 401 });
      expect(tenant.auth0.state.exchangeCount).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it("does not let concurrent callers for different subjects share one exchange", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const app = await startApp(wiring, tenant, {
      client: makeMcpClient(tenant),
      createServer: serverFor(tenant),
    });
    try {
      const subs = ["user|1", "user|2", "user|3", "user|4"];
      const outcomes = await Promise.all(
        subs.map(async (sub) => delegateOnce(app, await rig().token({ sub }))),
      );

      expect(outcomes.map((o) => o.body.sub)).toEqual(subs);
      expect(tenant.auth0.state.exchangeCount).toBe(subs.length);
    } finally {
      await app.stop();
    }
  });
});
