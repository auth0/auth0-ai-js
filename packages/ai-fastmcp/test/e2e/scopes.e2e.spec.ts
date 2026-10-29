/**
 * Scopes through a real FastMCP server, against the real tenant. The server-wide gate answers 403
 * before a session exists, the per-tool wrapper answers with a tool error that names the missing
 * scope, and FastMCP's `canAccess` hides a tool. Callers are a user who holds every tool scope
 * and a client that holds `tool:whoami` only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callTool,
  connect,
  describeLive,
  expectNoTokens,
  firstUser,
  LIMITED_CLIENT_VARS,
  limitedClient,
  listToolNames,
  postInitialize,
  startDownstreamApi,
  startFastMcpServer,
} from "./support/index.js";
import type { DownstreamApi, FastMcpServer } from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

describeLive("fastmcp scopes", LIMITED_CLIENT_VARS, (e2e) => {
  const user = firstUser(e2e);
  const limited = limitedClient(e2e);
  let downstream: DownstreamApi;
  let userToken: string;
  let limitedToken: string;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await user.token();
    limitedToken = await limited.token();
  });

  afterAll(async () => {
    await downstream?.close();
  });

  describe.each(MODES)("$label server without a server-wide scope", ({ stateless }) => {
    let server: FastMcpServer;

    beforeAll(async () => {
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("FM-08 a tool wrapper names the missing scope in a tool error and the tool stays listed", async () => {
      const session = await connect(server, limitedToken);
      try {
        expect(await listToolNames(session)).toContain("needs_delegate");
        const outcome = await callTool(session, "needs_delegate");
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toBe("Missing required scope: tool:delegate");
        expect(outcome.meta).toEqual({ error: "insufficient_scope" });
      } finally {
        await session.close();
      }
    });

    it("FM-08 the same tool runs for a caller who holds the scope", async () => {
      const session = await connect(server, userToken);
      try {
        const outcome = await callTool(session, "needs_delegate");
        expect(outcome.isError).toBe(false);
        expect(outcome.text).toBe("delegate allowed");
      } finally {
        await session.close();
      }
    });

    it("FM-08 a scope that no caller holds is denied for the user too, and the text carries only the scope name", async () => {
      const session = await connect(server, userToken);
      try {
        const outcome = await callTool(session, "needs_never");
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toBe("Missing required scope: e2e:never-granted");
        expectNoTokens("the tool error", outcome.text, [userToken]);
      } finally {
        await session.close();
      }
    });

    it("FM-08 canAccess hides a tool from a caller without the scope and lists it for a caller with it", async () => {
      const without = await connect(server, limitedToken);
      const withScope = await connect(server, userToken);
      try {
        expect(await listToolNames(without)).not.toContain("hidden_without_delegate");
        expect(await listToolNames(withScope)).toContain("hidden_without_delegate");

        const direct = await callTool(without, "hidden_without_delegate").then(
          () => undefined,
          (error: unknown) => error as { code?: number; message?: string },
        );
        expect(direct, "calling a hidden tool must fail at the protocol level").toBeDefined();
        // FastMCP answers with method-not-found or invalid-params depending on its version.
        expect([-32601, -32602]).toContain(direct!.code);

        const allowed = await callTool(withScope, "hidden_without_delegate");
        expect(allowed.isError).toBe(false);
        expect(allowed.text).toBe("hidden allowed");
      } finally {
        await without.close();
        await withScope.close();
      }
    });

    it("FM-08 the session scopes of each caller are exactly the scopes of its token", async () => {
      const limitedSession = await connect(server, limitedToken);
      const userSession = await connect(server, userToken);
      try {
        const small = await callTool<{ scopes: string[] }>(limitedSession, "whoami");
        const large = await callTool<{ scopes: string[] }>(userSession, "whoami");
        expect(small.value.scopes).toEqual(["tool:whoami"]);
        expect([...large.value.scopes].sort()).toEqual([...user.scopes].sort());
      } finally {
        await limitedSession.close();
        await userSession.close();
      }
    });
  });

  describe.each(MODES)("$label server with a server-wide scope", ({ stateless }) => {
    let server: FastMcpServer;

    beforeAll(async () => {
      server = await startFastMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        stateless,
        auth: { requiredScopes: ["tool:delegate"] },
      });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("FM-08 a caller without the scope is refused with 403 insufficient_scope, a scope parameter and a metadata URL", async () => {
      const res = await postInitialize(server, `Bearer ${limitedToken}`);
      expect(res.status).toBe(403);
      expect(res.challenge?.scheme).toBe("Bearer");
      expect(res.challenge?.params["error"]).toBe("insufficient_scope");
      expect(res.challenge?.params["scope"]).toBe("tool:delegate");
      expect(res.challenge?.params["resource_metadata"]).toMatch(/\/\.well-known\/oauth-protected-resource\/mcp$/);
      expectNoTokens("the response", res.body, [limitedToken]);
    });

    it("FM-08 a real client sees the 403 and no session is created", async () => {
      const failure = await connect(server, limitedToken).then(
        () => undefined,
        (error: Error & { seen: Array<{ status: number }> }) => error,
      );
      expect(failure).toBeDefined();
      expect(failure!.seen[0]!.status).toBe(403);
    });

    it("FM-08 a caller with the scope is served", async () => {
      const session = await connect(server, userToken);
      try {
        const outcome = await callTool<{ sessionSub: string }>(session, "whoami");
        expect(outcome.isError).toBe(false);
        expect(outcome.value.sessionSub).toMatch(/\|/);
      } finally {
        await session.close();
      }
    });
  });
});
