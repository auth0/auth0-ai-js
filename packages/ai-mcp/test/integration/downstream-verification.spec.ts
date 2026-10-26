import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestKey, mintAccessToken } from "../support/index.js";
import {
  DOWNSTREAM,
  WIRINGS,
  buildToolServer,
  callJson,
  connectClient,
  createRig,
  makeMcpClient,
  withApp,
} from "./harness.js";
import type { DelegateOutcome } from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

describe.each(WIRINGS)("downstream token verification (%s wiring)", (wiring) => {
  async function viaTool(name: string) {
    const { tenant } = rig();
    rig().useTenant();
    return withApp(
      wiring,
      tenant,
      { client: makeMcpClient(tenant), createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }) },
      async (app) => {
        const session = await connectClient(app, await rig().token({ sub: "user|d" }));
        try {
          return await callJson<DelegateOutcome>(session, name);
        } finally {
          await session.close();
        }
      },
    );
  }

  it("accepts the exchanged token: right issuer, audience, signature and scope", async () => {
    const { value } = await viaTool("delegate");

    expect(value.status).toBe(200);
    expect(value.body).toMatchObject({ ok: true, sub: "user|d", scopes: ["api:read"] });
    expect(rig().tenant.oracle.calls.map((c) => c.verdict.ok)).toEqual([true]);
  });

  it("rejects the caller's own inbound token, which is issued for this server and not for the API", async () => {
    const { value } = await viaTool("forward_inbound");

    expect(value.status).toBe(401);
    expect(value.body).toMatchObject({ ok: false, reason: "wrong_audience" });
  });

  it("rejects a token with a forged signature and a token without the required scope", async () => {
    const { tenant } = rig();
    rig().useTenant();
    const forged = await mintAccessToken(await createTestKey(), {
      iss: tenant.auth0.issuer,
      aud: DOWNSTREAM,
      sub: "user|d",
      scope: "api:read",
    });
    const unscoped = await mintAccessToken(tenant.key, {
      iss: tenant.auth0.issuer,
      aud: DOWNSTREAM,
      sub: "user|d",
      scope: "other:scope",
    });

    const forgedResponse = await fetch(tenant.downstreamUrl, { headers: { authorization: `Bearer ${forged}` } });
    const unscopedResponse = await fetch(tenant.downstreamUrl, { headers: { authorization: `Bearer ${unscoped}` } });

    expect(forgedResponse.status).toBe(401);
    expect(await forgedResponse.json()).toMatchObject({ reason: "bad_signature" });
    expect(unscopedResponse.status).toBe(403);
    expect(await unscopedResponse.json()).toMatchObject({ reason: "missing_scope" });
  });

  it("fails the run when a rejected token reaches the downstream API unexpectedly", async () => {
    await viaTool("forward_inbound");

    expect(() => rig().assertAllForwardedTokensVerified()).toThrow(/wrong_audience/);
  });
});
