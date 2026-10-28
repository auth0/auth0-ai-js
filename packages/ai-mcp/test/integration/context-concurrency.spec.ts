import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import type { ContextProbe, DelegateOutcome } from "./harness.js";
import { getRequestContext } from "../../src/request-context.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

const CALLERS = 6;

describe.each(WIRINGS)("request context under concurrency (%s wiring)", (wiring) => {
  it("shows every concurrent caller only its own principal and client", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const barrier = createBarrier(CALLERS);
    await withApp(
      wiring,
      tenant,
      {
        client: makeMcpClient(tenant),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl, barrier }),
      },
      async (app) => {
        const subs = Array.from({ length: CALLERS }, (_, i) => `user|caller-${i}`);
        const results = await Promise.all(
          subs.map(async (sub) => {
            const session = await connectClient(app, await rig().token({ sub }));
            try {
              return await callJson<{ contextSub: string; clientSub: string }>(session, "whoami");
            } finally {
              await session.close();
            }
          }),
        );

        expect(results.map((r) => r.value.contextSub)).toEqual(subs);
        expect(results.map((r) => r.value.clientSub)).toEqual(subs);
      },
    );
  });

  it("exchanges and forwards each concurrent caller's own token", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const barrier = createBarrier(CALLERS);
    await withApp(
      wiring,
      tenant,
      {
        client: makeMcpClient(tenant),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl, barrier }),
      },
      async (app) => {
        const subs = Array.from({ length: CALLERS }, (_, i) => `user|caller-${i}`);
        const results = await Promise.all(
          subs.map(async (sub) => {
            const session = await connectClient(app, await rig().token({ sub }));
            try {
              return await callJson<DelegateOutcome>(session, "delegate");
            } finally {
              await session.close();
            }
          }),
        );

        expect(results.map((r) => r.value.body.sub)).toEqual(subs);
        expect(tenant.auth0.state.successfulExchangeCount).toBe(CALLERS);
        rig().assertAllForwardedTokensVerified();
      },
    );
  });

  it("gives a later request, from another caller or none, nothing from an earlier one", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const probe: ContextProbe = { captured: [], latch: Promise.resolve(), pending: [] };
    let open!: () => void;
    probe.latch = new Promise<void>((resolve) => (open = resolve));
    await withApp(
      wiring,
      tenant,
      {
        client: makeMcpClient(tenant),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl, probe }),
      },
      async (app) => {
        const first = await connectClient(app, await rig().token({ sub: "user|first" }));
        try {
          await callJson(first, "capture");
          // A continuation that outlives the call must still see its own caller.
          await callJson(first, "linger");
        } finally {
          await first.close();
        }

        const second = await connectClient(app, await rig().token({ sub: "user|second" }));
        try {
          const seen = await callJson<{ sub: string; sameObjectAsEarlier: boolean; earlierSubs: string[] }>(
            second,
            "compare",
          );
          expect(seen.value.sub).toBe("user|second");
          expect(seen.value.sameObjectAsEarlier).toBe(false);
          expect(seen.value.earlierSubs).toEqual(["user|first"]);
        } finally {
          await second.close();
        }

        // A request without credentials never reaches a tool and must not disturb anyone's context.
        await expect(connectClient(app)).rejects.toMatchObject({ status: 401 });

        open();
        expect(await Promise.all(probe.pending)).toEqual(["user|first"]);
        expect(getRequestContext()).toBeUndefined();
      },
    );
  });
});
