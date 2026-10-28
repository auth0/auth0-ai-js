import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  WIRINGS,
  buildToolServer,
  callJson,
  connectClient,
  createRig,
  delegateOnce,
  makeMcpClient,
  startApp,
} from "./harness.js";
import type { McpClientOptions } from "../../src/types.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

describe.each(WIRINGS)("organization policy at ingress (%s wiring)", (wiring) => {
  async function serve(overrides: Partial<McpClientOptions>) {
    const { tenant } = rig();
    rig().useTenant();
    return startApp(wiring, tenant, {
      client: makeMcpClient(tenant, overrides),
      createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
    });
  }

  const allowList: Partial<McpClientOptions> = { organizationPolicy: "required", organizationId: ["org_allowed"] };

  it("rejects a token without an organization when one is required", async () => {
    const app = await serve(allowList);
    try {
      await expect(connectClient(app, await rig().token())).rejects.toMatchObject({ status: 401 });
      expect(rig().tenant.auth0.state.exchangeCount).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it("rejects a token from an organization that is not allowed", async () => {
    const app = await serve(allowList);
    try {
      const bearer = await rig().token({ claims: { client_id: "client-a", org_id: "org_other" } });

      const error = await connectClient(app, bearer).then(
        () => undefined,
        (e: unknown) => e as { status: number; seen: Array<{ wwwAuthenticate: string | null }> },
      );

      expect(error?.status).toBe(401);
      expect(error?.seen[0]!.wwwAuthenticate).toContain('error="invalid_token"');
      expect(rig().tenant.auth0.state.exchangeCount).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it("accepts a token from an allowed organization and carries it downstream", async () => {
    const app = await serve(allowList);
    try {
      const bearer = await rig().token({ claims: { client_id: "client-a", org_id: "org_allowed" } });
      const session = await connectClient(app, bearer);
      try {
        const who = await callJson<{ orgId: string }>(session, "whoami");
        expect(who.value.orgId).toBe("org_allowed");
      } finally {
        await session.close();
      }

      const outcome = await delegateOnce(app, bearer);

      expect(outcome.body).toMatchObject({ ok: true, orgId: "org_allowed" });
      rig().assertAllForwardedTokensVerified();
    } finally {
      await app.stop();
    }
  });

  it("accepts any organization when the policy is required without an allow list", async () => {
    const app = await serve({ organizationPolicy: "required" });
    try {
      const bearer = await rig().token({ claims: { client_id: "client-a", org_id: "org_any" } });

      expect((await delegateOnce(app, bearer)).body.orgId).toBe("org_any");
      await expect(connectClient(app, await rig().token())).rejects.toMatchObject({ status: 401 });
    } finally {
      await app.stop();
    }
  });

  it("does not check organizations when the policy is allow", async () => {
    const app = await serve({});
    try {
      expect((await delegateOnce(app, await rig().token())).body.orgId).toBeNull();
    } finally {
      await app.stop();
    }
  });
});
