/**
 * The on-behalf-of exchange through a real FastMCP server, against the real tenant. The tool
 * exchanges the caller's token through the session client; a local downstream API verifies the
 * exchanged token against the tenant keys and reports its claims. Exchanges are counted at the
 * tenant's token endpoint, which is how cache hits and single-flight show.
 */
import { MemoryIndexedTokenStore } from "@auth0/ai-mcp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ERROR_CANARY,
  callTool,
  connect,
  describeLive,
  expectNoSecrets,
  expectNoTokens,
  firstUser,
  installFetchCounter,
  limitedClient,
  startDownstreamApi,
  startFastMcpServer,
  subjectOf,
} from "./support/index.js";
import type {
  DelegateResult,
  DownstreamApi,
  DownstreamClaimsBody,
  FastMcpServer,
  FetchCounter,
  Session,
} from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

describeLive("fastmcp on-behalf-of exchange", [], (e2e) => {
  const user = firstUser(e2e);
  const hasLimited = e2e.limitedClientId !== "";
  let downstream: DownstreamApi;
  let userToken: string;
  let limitedToken = "";

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await user.token();
    if (hasLimited) limitedToken = await limitedClient(e2e).token();
  });

  afterAll(async () => {
    await downstream?.close();
  });

  describe.each(MODES)("$label server", ({ stateless }) => {
    let counter: FetchCounter | undefined;
    let server: FastMcpServer | undefined;
    let session: Session | undefined;
    let store: MemoryIndexedTokenStore;

    /** Starts the server with a store, connects the user and warms verification, so only exchanges are counted. */
    async function boot(withStore: boolean): Promise<Session> {
      server = await startFastMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        stateless,
        ...(withStore && { clientOptions: { tokenStore: store } }),
      });
      session = await connect(server, userToken);
      await callTool(session, "whoami");
      counter!.reset();
      downstream.calls.length = 0;
      return session;
    }

    beforeEach(() => {
      // The counter goes in before the server, so any fetch reference taken at construction is wrapped.
      counter = installFetchCounter();
      store = new MemoryIndexedTokenStore();
    });

    afterEach(async () => {
      counter?.restore();
      await session?.close();
      await server?.stop();
      counter = undefined;
      session = undefined;
      server = undefined;
      downstream.calls.length = 0;
    });

    it("FM-03 the exchanged token reaches the downstream API for the caller, with the exchange client as actor", async () => {
      const active = await boot(true);
      const { isError, value, text } = await callTool<DelegateResult>(active, "delegate", { scope: "work:read" });
      expect(isError).toBe(false);
      expect(value.status).toBe(200);
      expect(value.grantedScopes).toContain("work:read");
      const claims = value.body as unknown as DownstreamClaimsBody;
      expect(claims.ok).toBe(true);
      expect(claims.aud).toEqual(e2e.downstreamAudience);
      expect(claims.sub).toBe(subjectOf(userToken));
      expect(claims.scope?.split(" ")).toContain("work:read");
      expect(claims.act?.sub).toBe(e2e.oboClientId);
      expect(downstream.calls.map((call) => call.status)).toEqual([200]);
      expect(text).not.toMatch(JWT_SHAPE);
      expectNoTokens("the tool result", text, [userToken]);
    });

    it("FM-03 the accessor reaches the same client as the session does", async () => {
      const active = await boot(true);
      const { isError, value } = await callTool<{ bound: boolean; hasToken?: boolean }>(active, "delegate_via_accessor");
      expect(isError).toBe(false);
      expect(value).toEqual({ bound: true, hasToken: true });
      expect(counter!.exchanges).toBe(1);
    });

    it("FM-03 a second call is answered from the store: one exchange, two downstream calls", async () => {
      const active = await boot(true);
      for (let i = 0; i < 2; i += 1) {
        const { isError, value } = await callTool<DelegateResult>(active, "delegate", { scope: "work:read" });
        expect(isError).toBe(false);
        expect(value.status).toBe(200);
      }
      expect(counter!.exchanges).toBe(1);
      expect(downstream.calls.map((call) => call.status)).toEqual([200, 200]);
      expect(store.size).toBe(1);
    });

    it("FM-03 another scope set is another exchange and another store entry", async () => {
      const active = await boot(true);
      await callTool(active, "delegate", { scope: "work:read" });
      const wider = await callTool<DelegateResult>(active, "delegate", { scope: "work:read work:write" });
      expect(wider.isError).toBe(false);
      expect([...wider.value.grantedScopes].sort()).toEqual(["work:read", "work:write"]);
      expect(counter!.exchanges).toBe(2);
      expect(store.size).toBe(2);
    });

    it("FM-13 ten concurrent identical calls collapse into one exchange", async () => {
      const active = await boot(true);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => callTool<DelegateResult>(active, "delegate", { scope: "work:read" })),
      );
      for (const { isError, value } of results) {
        expect(isError).toBe(false);
        expect(value.status).toBe(200);
      }
      expect(counter!.exchanges).toBe(1);
      expect(downstream.calls).toHaveLength(10);
      expect(store.size).toBe(1);
    });

    it("FM-13 without a store nothing is cached: concurrent calls share one exchange, a later call exchanges again", async () => {
      const active = await boot(false);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => callTool<DelegateResult>(active, "delegate", { scope: "work:read" })),
      );
      expect(results.every((result) => !result.isError && result.value.status === 200)).toBe(true);
      expect(counter!.exchanges).toBe(1);

      await callTool(active, "delegate", { scope: "work:read" });
      expect(counter!.exchanges).toBe(2);
    });

    it("FM-07 an audience the tenant does not know is refused by the tenant: a fixed tool error, nothing cached, the next call works", async () => {
      const active = await boot(true);
      const refused = await callTool(active, "delegate", { audience: "https://unknown.invalid/e2e-no-such-api" });
      expect(refused.isError).toBe(true);
      // The scoped client already replaced the tenant's answer with a plain error, so the generic text applies.
      expect(refused.text).toBe("Tool execution failed.");
      expect(refused.meta).toEqual({ error: "server_error" });
      expect(server!.errors).toHaveLength(1);
      expectNoTokens("the tool error", refused.text, [userToken]);
      expect(store.size).toBe(0);

      const next = await callTool<DelegateResult>(active, "delegate", { scope: "work:read" });
      expect(next.isError).toBe(false);
      expect(next.value.status).toBe(200);
    });

    it("FM-07 an error with a secret in its message reaches the client as fixed text", async () => {
      const active = await boot(true);
      const outcome = await callTool(active, "throws_canary");
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe("Tool execution failed.");
      expect(outcome.meta).toEqual({ error: "server_error" });
      expectNoSecrets("the tool error", `${outcome.text}${JSON.stringify(outcome.meta)}`, [ERROR_CANARY]);
      expect(String((server!.errors[0] as Error).message)).toContain(ERROR_CANARY);
    });

    it("FM-07 a FastMCP UserError passes through with its own text", async () => {
      const active = await boot(true);
      const outcome = await callTool(active, "user_error");
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe("the order does not exist");
    });

    it.skipIf(!hasLimited)(
      "FM-07 pinned-tenant: a client credentials caller cannot be exchanged on behalf of a user; the tool error is fixed text",
      async () => {
        server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless, clientOptions: { tokenStore: store } });
        const machine = await connect(server, limitedToken);
        session = machine;
        const outcome = await callTool(machine, "delegate", { scope: "work:read" });
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toBe("Tool execution failed.");
        expect(downstream.calls).toEqual([]);
      },
    );
  });
});
