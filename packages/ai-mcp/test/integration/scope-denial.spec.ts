import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  WIRINGS,
  buildToolServer,
  callJson,
  connectClient,
  createRig,
  makeMcpClient,
  withApp,
} from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

describe.each(WIRINGS)("scope enforcement (%s wiring)", (wiring) => {
  function options(extra: Record<string, unknown> = {}) {
    const { tenant } = rig();
    rig().useTenant();
    const createServer = vi.fn(() => buildToolServer({ downstreamUrl: tenant.downstreamUrl }));
    return { tenant, createServer, handler: { client: makeMcpClient(tenant), createServer, ...extra } };
  }

  it("answers a per-tool scope denial with an isError result and HTTP 200", async () => {
    const { tenant, handler } = options();
    await withApp(wiring, tenant, handler, async (app) => {
      const session = await connectClient(app, await rig().token({ scope: "read" }));
      try {
        const denied = await callJson<string>(session, "admin");

        expect(denied.isError).toBe(true);
        expect(denied.value).toBe("Missing one or more required scopes.");
        // The tool call itself was answered with 200, not an HTTP error.
        const answers = session.seen.filter((r) => r.contentType?.includes("application/json"));
        expect(answers.at(-1)!.status).toBe(200);
        expect(session.seen.some((r) => r.status === 401 || r.status === 403)).toBe(false);
      } finally {
        await session.close();
      }
    });
  });

  it("runs the tool when the per-tool scope is held", async () => {
    const { tenant, handler } = options();
    await withApp(wiring, tenant, handler, async (app) => {
      const session = await connectClient(app, await rig().token({ scope: "read admin" }));
      try {
        const allowed = await callJson<{ secret: boolean }>(session, "admin");

        expect(allowed.isError).toBe(false);
        expect(allowed.value).toEqual({ secret: true });
      } finally {
        await session.close();
      }
    });
  });

  it("answers 403 insufficient_scope listing only the missing server-wide scopes", async () => {
    const { tenant, createServer, handler } = options({ requiredScopes: ["read", "admin"], realm: "mcp-test" });
    await withApp(wiring, tenant, handler, async (app) => {
      const error = await connectClient(app, await rig().token({ scope: "read" })).then(
        () => undefined,
        (e: unknown) => e as { code: number; seen: Array<{ wwwAuthenticate: string | null }> },
      );

      expect(error?.code).toBe(403);
      const challenge = error!.seen[0]!.wwwAuthenticate!;
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain('scope="admin"');
      expect(challenge).toContain('realm="mcp-test"');
      expect(challenge).toContain("resource_metadata=");
      expect(createServer).not.toHaveBeenCalled();
    });
  });

  it("serves a caller who holds every server-wide scope", async () => {
    const { tenant, handler } = options({ requiredScopes: ["read", "admin"] });
    await withApp(wiring, tenant, handler, async (app) => {
      const session = await connectClient(app, await rig().token({ scope: "read admin write" }));
      try {
        expect((await callJson(session, "whoami")).isError).toBe(false);
      } finally {
        await session.close();
      }
    });
  });
});
