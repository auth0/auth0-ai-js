/**
 * Several real, token-verifying services behind one MCP server, plus callers with different grants.
 *
 * The four store services (Orders, Inventory, Analytics, Ledger) are separate local HTTP servers
 * that verify every bearer against the tenant JWKS, issuer and their own audience. The server under
 * test exchanges the caller's token against the real tenant for each audience. Nothing is mocked:
 * the services log what they verified, and the fetch counter counts the exchanges that reached the
 * tenant.
 *
 * Scenario ids (E-M-01 and so on) are part of the test titles; the runner builds report rows from them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import { getRequestContext } from "../../src/request-context.js";
import { withRequiredScopes } from "../../src/scopes.js";
import {
  LIMITED_CLIENT_VARS,
  MULTI_SERVICE_VARS,
  TOKEN_EXCHANGE_GRANT,
  callToolJson,
  connectMcpClient,
  decodeClaims,
  getClientCredentialsToken,
  getUserToken,
  installFetchCounter,
  loadE2eEnv,
  postTokenRequest,
  startDownstreams,
  startMcpServer,
} from "./support/index.js";
import type {
  ConnectedClient,
  DelegateResult,
  DownstreamTarget,
  Downstreams,
  E2eMcpServer,
  FetchCounter,
  MultiDownstreamResult,
} from "./support/index.js";

const e2e = loadE2eEnv([...MULTI_SERVICE_VARS, ...LIMITED_CLIENT_VARS]);

/** Scope each service route needs; the exchange asks for exactly this. */
const SCOPE = {
  orders: "read:orders",
  inventory: "read:inventory",
  analytics: "read:analytics",
  ledger: "read:ledger",
} as const;

/** Tool scopes the MCP API defines. */
const TOOL_SCOPES = "tool:whoami tool:delegate tool:order_status_report tool:sales_analytics_report";

/** The generic text every sanitized token failure carries. */
const PUBLIC_FAILURE_TEXT = "The token operation failed.";

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Result of one service in the `store-report` tool. Never contains a token. */
interface StoreReportEntry {
  service: "orders" | "inventory" | "analytics";
  status: number;
  grantedScopes: string[];
}

/**
 * Registers the tools these scenarios use besides the shared ones:
 * - `scoped_whoami` and `order_status_report`, guarded by tool scopes;
 * - `store-report`, which calls Orders and Inventory with tokens exchanged on behalf of the caller and
 *   Analytics with a client credentials token (the tenant defines Analytics as a machine-only API);
 * - `machine-token`, which asks the tenant for a client credentials token and reports only the outcome.
 */
function registerTools(urls: Downstreams["urls"]) {
  return (mcp: McpServer): void => {
    mcp.registerTool(
      "scoped_whoami",
      { description: "Needs tool:whoami." },
      withRequiredScopes("tool:whoami", async () => json({ ok: true })),
    );
    mcp.registerTool(
      "order_status_report",
      { description: "Needs tool:order_status_report." },
      withRequiredScopes("tool:order_status_report", async () => json({ ok: true })),
    );
    mcp.registerTool(
      "store-report",
      { description: "Orders and Inventory on behalf of the caller, Analytics as the server.", inputSchema: z.object({ parallel: z.boolean().optional() }) },
      async ({ parallel }) => {
        const context = getRequestContext();
        if (context === undefined) throw new Error("No request context.");
        const run = async (
          service: StoreReportEntry["service"],
          url: string,
          obtain: () => Promise<{ accessToken: string; grantedScopes: string[] }>,
        ): Promise<StoreReportEntry> => {
          const token = await obtain();
          const response = await fetch(url, { headers: { authorization: `Bearer ${token.accessToken}` } });
          await response.arrayBuffer();
          return { service, status: response.status, grantedScopes: [...token.grantedScopes] };
        };
        const calls = [
          () => run("orders", `${urls.orders}/orders`, () => context.mcpClient.getTokenOnBehalfOf({ audience: e2e.ordersAudience, scope: SCOPE.orders })),
          () => run("inventory", `${urls.inventory}/inventory`, () => context.mcpClient.getTokenOnBehalfOf({ audience: e2e.inventoryAudience, scope: SCOPE.inventory })),
          () => run("analytics", `${urls.analytics}/analytics/monthly-revenue`, () => context.mcpClient.getClientCredentialsToken({ audience: e2e.analyticsAudience, scope: SCOPE.analytics })),
        ];
        const results: StoreReportEntry[] = [];
        if (parallel === true) results.push(...(await Promise.all(calls.map((c) => c()))));
        else for (const c of calls) results.push(await c());
        return json({ results });
      },
    );
    mcp.registerTool(
      "machine-token",
      { description: "Client credentials token for an audience; reports the outcome only.", inputSchema: z.object({ audience: z.string(), scope: z.string() }) },
      async ({ audience, scope }) => {
        const context = getRequestContext();
        if (context === undefined) throw new Error("No request context.");
        const token = await context.mcpClient.getClientCredentialsToken({ audience, scope });
        return json({ ok: true, grantedScopes: [...token.grantedScopes] });
      },
    );
  };
}

describe("e2e multiple verifying services and caller grants", () => {
  const jwksUri = `https://${e2e.domain}/.well-known/jwks.json`;
  let services: Downstreams;
  let counter: FetchCounter | undefined;
  let servers: E2eMcpServer[] = [];
  let sessions: ConnectedClient[] = [];
  let userToken: string;

  const audienceOf = {
    orders: e2e.ordersAudience,
    inventory: e2e.inventoryAudience,
    analytics: e2e.analyticsAudience,
    ledger: e2e.ledgerAudience,
  };

  function targets(): DownstreamTarget[] {
    return [
      { audience: audienceOf.orders, url: `${services.urls.orders}/orders`, scope: SCOPE.orders },
      { audience: audienceOf.inventory, url: `${services.urls.inventory}/inventory`, scope: SCOPE.inventory },
      { audience: audienceOf.analytics, url: `${services.urls.analytics}/analytics/monthly-revenue`, scope: SCOPE.analytics },
    ];
  }

  beforeAll(async () => {
    services = await startDownstreams({ jwksUri, issuer: e2e.issuer, audiences: audienceOf });
    userToken = await getUserToken(e2e, { scope: TOOL_SCOPES });
  });

  beforeEach(() => {
    counter = installFetchCounter();
  });

  afterEach(async () => {
    counter?.restore();
    for (const session of sessions) await session.close();
    for (const server of servers) await server.close();
    sessions = [];
    servers = [];
    services.log.length = 0;
  });

  afterAll(async () => {
    await services.close();
  });

  async function boot(
    options: {
      store?: MemoryIndexedTokenStore | null;
      token?: string;
      downstreams?: readonly DownstreamTarget[];
      downstreamUrl?: string;
    } = {},
  ) {
    const server = await startMcpServer({
      env: e2e,
      downstreamUrl: options.downstreamUrl ?? `${services.urls.orders}/orders`,
      tokenStore: options.store ?? null,
      downstreams: options.downstreams ?? targets(),
      registerTools: registerTools(services.urls),
    });
    servers.push(server);
    const session = await connectMcpClient(server.url, options.token ?? userToken);
    sessions.push(session);
    // Warm the JWKS and discovery path so only exchanges are counted below.
    await callToolJson(session.client, "whoami");
    counter!.reset();
    services.log.length = 0;
    return session.client;
  }

  const report = (client: ConnectedClient["client"], args: Record<string, unknown> = {}) =>
    callToolJson<{ results: StoreReportEntry[] }>(client, "store-report", args);
  const cross = (client: ConnectedClient["client"], args: Record<string, unknown> = {}) =>
    callToolJson<MultiDownstreamResult>(client, "multi-downstream", args);
  const statuses = (value: { results: Array<{ status: number }> }) => value.results.map((r) => r.status);

  it("E-M-01 one tool call reaches Orders, Inventory and Analytics and each service verifies its own token", async () => {
    const client = await boot();
    const userSub = decodeClaims(userToken)["sub"];

    const { isError, value } = await report(client);

    expect(isError).toBe(false);
    expect(value.results.map((r) => r.service)).toEqual(["orders", "inventory", "analytics"]);
    expect(statuses(value)).toEqual([200, 200, 200]);
    // Two exchanges on behalf of the user and one client credentials grant: three token requests in all.
    expect(counter!.exchanges).toBe(2);
    expect(counter!.count("client_credentials")).toBe(1);

    const audiences = { orders: e2e.ordersAudience, inventory: e2e.inventoryAudience, analytics: e2e.analyticsAudience };
    for (const service of ["orders", "inventory", "analytics"] as const) {
      const entries = services.log.filter((e) => e.service === service);
      expect(entries, `${service} must have seen exactly one request`).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.outcome).toBe("ok");
      expect([entry.aud].flat()).toContain(audiences[service]);
      expect(entry.scope?.split(" ")).toContain(SCOPE[service]);
      if (service === "analytics") {
        // The server's own token: the subject is the exchanging client, there is no user and no actor.
        expect(entry.sub).toBe(`${e2e.oboClientId}@clients`);
        expect(entry.act).toBeUndefined();
      } else {
        // On behalf of the user: the actor chain names the exchanging client, and below it the client
        // the user logged in with.
        expect(entry.sub).toBe(userSub);
        expect(entry.act?.sub).toBe(e2e.oboClientId);
        expect(entry.act?.act?.sub).toBe(e2e.loginClientId);
      }
    }
    expect(services.log.some((e) => e.service === "ledger")).toBe(false);
  });

  it("E-M-02 a token minted for Orders is refused by Inventory and the refusal does not echo it", async () => {
    // Pair the Orders audience with the Inventory URL: the exchanged Orders token is sent to Inventory.
    const crossed: DownstreamTarget[] = [
      { audience: e2e.ordersAudience, url: `${services.urls.orders}/orders`, scope: SCOPE.orders },
      { audience: e2e.ordersAudience, url: `${services.urls.inventory}/inventory`, scope: SCOPE.orders },
    ];
    const client = await boot({ downstreams: crossed });

    const { isError, value } = await cross(client);

    expect(isError).toBe(false);
    expect(statuses(value)).toEqual([200, 401]);
    expect(services.log.map((e) => [e.service, e.outcome])).toEqual([
      ["orders", "ok"],
      ["inventory", "invalid_token"],
    ]);
    // A rejected token leaves no claims in the service log.
    expect(services.log[1]!.sub).toBeUndefined();
    const refusal = JSON.stringify(value.results[1]);
    expect(refusal).not.toContain(userToken);
    expect(JWT_SHAPE.test(refusal), "refusal must not contain a JWT").toBe(false);
    expect(value.results[1]!.body).toEqual({ error: "invalid_token" });
  });

  it("E-M-03 a repeat call is answered from the cache for the user-bound audiences", async () => {
    const store = new MemoryIndexedTokenStore();
    const client = await boot({ store });

    const first = await report(client);
    expect(statuses(first.value)).toEqual([200, 200, 200]);
    expect(counter!.exchanges).toBe(2);
    expect(store.size).toBe(2);

    counter!.reset();
    const second = await report(client);

    expect(second.isError).toBe(false);
    expect(statuses(second.value)).toEqual([200, 200, 200]);
    expect(counter!.exchanges).toBe(0);
    expect(store.size).toBe(2);
    // Documented: client credentials tokens are not cached, so the Analytics token is requested again.
    expect(counter!.count("client_credentials")).toBe(1);
    expect(services.log.filter((e) => e.outcome === "ok")).toHaveLength(6);
  });

  // No store here, so the only thing that can share exchanges between concurrent calls is the single
  // flight. Ten calls each want both user-bound audiences; two exchanges in total means each audience was
  // exchanged exactly once (every call needs every audience, so none can have been skipped). The client
  // credentials grant is not shared between callers (documented), so every call makes its own.
  it("E-M-04 ten concurrent calls exchange each user-bound audience once", async () => {
    const client = await boot({ store: null });

    const results = await Promise.all(Array.from({ length: 10 }, () => report(client, { parallel: true })));

    for (const { isError, value } of results) {
      expect(isError).toBe(false);
      expect(statuses(value)).toEqual([200, 200, 200]);
    }
    expect(counter!.exchanges).toBe(2);
    expect(counter!.count("client_credentials")).toBe(10);
    expect(services.log.filter((e) => e.outcome === "ok")).toHaveLength(30);
  });

  // Pinned tenant behavior. The setup script defines Analytics as a machine-only API (user consent is
  // not skipped and the exchange client holds no user-bound grant), and the tenant refuses an exchange
  // on behalf of a user for it. If the tenant is changed to allow it, this test fails on purpose.
  it("E-M-05 pinned-tenant: an exchange on behalf of the user for the machine-only Analytics API is refused and sanitized", async () => {
    const analytics: DownstreamTarget[] = [
      { audience: e2e.analyticsAudience, url: `${services.urls.analytics}/analytics/monthly-revenue`, scope: SCOPE.analytics },
    ];
    const store = new MemoryIndexedTokenStore();
    const client = await boot({ store, downstreams: analytics });

    const { isError, value } = await callToolJson<unknown>(client, "multi-downstream");

    expect(isError).toBe(true);
    const text = String(value);
    expect(text).toBe(PUBLIC_FAILURE_TEXT);
    expect(text.includes(e2e.analyticsAudience)).toBe(false);
    expect(counter!.exchanges).toBe(1);
    expect(services.log).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  describe("caller grants", () => {
    /** Raw `tools/call` over HTTP, to see the status line the SDK client hides. */
    async function rawToolCall(url: URL, token: string, name: string) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } }),
      });
      const text = await response.text();
      return { status: response.status, text };
    }

    it("E-S-01 a caller whose token lacks a tool scope gets a tool error while its other tools work", async () => {
      // The limited client is granted only tool:whoami on the MCP API. Without a scope in the request
      // the tenant issues the granted scopes.
      const limited = await getClientCredentialsToken(e2e, {
        audience: e2e.mcpAudience,
        clientId: e2e.limitedClientId,
        clientSecret: e2e.limitedClientSecret,
        fresh: true,
      });
      const held = String(decodeClaims(limited)["scope"] ?? "").split(" ");
      expect(held).toContain("tool:whoami");
      expect(held).not.toContain("tool:order_status_report");

      const client = await boot({ token: limited });
      const server = servers[0]!;

      const denied = await callToolJson<unknown>(client, "order_status_report");
      expect(denied.isError).toBe(true);
      expect(String(denied.value)).toBe("Missing one or more required scopes.");
      expect(JSON.stringify(denied.value)).not.toContain(limited);

      // The denial is a normal answer on a healthy request, not a transport level rejection.
      const raw = await rawToolCall(server.url, limited, "order_status_report");
      expect(raw.status).toBe(200);
      expect(raw.text).toContain("insufficient_scope");

      const allowed = await callToolJson<{ ok: boolean }>(client, "scoped_whoami");
      expect(allowed.isError).toBe(false);
      expect(allowed.value).toEqual({ ok: true });
      const plain = await callToolJson<{ scopes: string[] }>(client, "whoami");
      expect(plain.isError).toBe(false);
      expect(plain.value.scopes).toContain("tool:whoami");

      // The user, who holds every tool scope, runs the guarded tool.
      const userClient = (await connectMcpClient(server.url, userToken));
      sessions.push(userClient);
      const permitted = await callToolJson<{ ok: boolean }>(userClient.client, "order_status_report");
      expect(permitted.isError).toBe(false);
      expect(permitted.value).toEqual({ ok: true });
    });

    // Pinned tenant behavior: for a client credentials grant the tenant refuses a scope outside the
    // client grant outright (it does not trim it), which is why the limited client above asks for none.
    it("E-S-01b pinned-tenant: the limited client asking for a tool scope it was not granted is refused by the tenant", async () => {
      const response = await postTokenRequest(e2e, {
        grant_type: "client_credentials",
        client_id: e2e.limitedClientId,
        client_secret: e2e.limitedClientSecret,
        audience: e2e.mcpAudience,
        scope: "tool:whoami tool:order_status_report",
      });
      expect(response.status).toBe(403);
      expect(response.body["error"]).toBe("access_denied");
      expect(response.body["access_token"]).toBeUndefined();
    });

    describe("scopes defined on an API but absent from the exchange client grant", () => {
      // The setup gives the exchange client a Ledger grant for read:ledger only; write:ledger is defined
      // on the API but not granted to it. These cases pin what the tenant really does with that.
      async function bootLedger(store: MemoryIndexedTokenStore) {
        return boot({ store, downstreamUrl: `${services.urls.ledger}/ledger`, downstreams: [] });
      }

      // Pinned tenant behavior. An exchange on behalf of a user is not capped by the scopes listed on the
      // client grant: the Ledger API skips consent for first-party clients, so the tenant issues every
      // defined scope that was requested, and reports it in `scope`. The wrapper therefore sees a full
      // grant and does not reject. If the tenant starts trimming to the grant, this fails on purpose and
      // the downscope path (covered with an undefined scope in the cache spec) becomes reachable here.
      it("E-S-03 pinned-tenant: a defined scope missing from the client grant is still issued on a user-bound exchange and cached under the granted set", async () => {
        const both = `${SCOPE.ledger} write:ledger`;
        const probe = await postTokenRequest(e2e, {
          grant_type: TOKEN_EXCHANGE_GRANT,
          client_id: e2e.oboClientId,
          client_secret: e2e.oboClientSecret,
          subject_token: userToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          audience: e2e.ledgerAudience,
          scope: both,
        });
        // The tenant always reports the scope it granted.
        expect(probe.status).toBe(200);
        expect(String(probe.body["scope"]).split(" ").sort()).toEqual(["read:ledger", "write:ledger"]);

        const store = new MemoryIndexedTokenStore();
        const client = await bootLedger(store);

        const first = await callToolJson<DelegateResult>(client, "delegate", { audience: e2e.ledgerAudience, scope: both });
        expect(first.isError).toBe(false);
        expect(first.value.status).toBe(200);
        expect([...first.value.grantedScopes].sort()).toEqual(["read:ledger", "write:ledger"]);
        expect(counter!.exchanges).toBe(1);
        expect(store.size).toBe(1);
        expect(services.log.map((e) => [e.service, e.outcome])).toEqual([["ledger", "ok"]]);
        expect(services.log[0]!.scope?.split(" ").sort()).toEqual(["read:ledger", "write:ledger"]);

        // Cached under the granted set: the same set is a hit, and a narrower set (strict mode) is a new exchange.
        const again = await callToolJson<DelegateResult>(client, "delegate", { audience: e2e.ledgerAudience, scope: `write:ledger ${SCOPE.ledger}` });
        expect(again.isError).toBe(false);
        expect(counter!.exchanges).toBe(1);
        const narrower = await callToolJson<DelegateResult>(client, "delegate", { audience: e2e.ledgerAudience, scope: SCOPE.ledger });
        expect(narrower.isError).toBe(false);
        expect(narrower.value.grantedScopes).toEqual([SCOPE.ledger]);
        expect(counter!.exchanges).toBe(2);
        expect(store.size).toBe(2);
      });

      // Pinned tenant behavior. The exchange client has no client credentials grant for the Ledger API
      // (its grant is user-bound), so a machine token for write:ledger, or for any scope of that API, is
      // refused with access_denied. The tenant text names the client id and the API, so the point of the
      // assertions is that none of it reaches the tool result, and that nothing is cached.
      it("E-S-04 pinned-tenant: a machine token for a defined scope with no grant is refused, sanitized, and nothing is cached", async () => {
        const probe = await postTokenRequest(e2e, {
          grant_type: "client_credentials",
          client_id: e2e.oboClientId,
          client_secret: e2e.oboClientSecret,
          audience: e2e.ledgerAudience,
          scope: "write:ledger",
        });
        expect({ status: probe.status, error: probe.body["error"] }).toEqual({ status: 403, error: "access_denied" });
        expect(probe.body["access_token"]).toBeUndefined();
        const description = String(probe.body["error_description"] ?? "");

        const store = new MemoryIndexedTokenStore();
        const client = await bootLedger(store);

        const result = await callToolJson<unknown>(client, "machine-token", { audience: e2e.ledgerAudience, scope: "write:ledger" });
        expect(result.isError).toBe(true);
        const text = String(result.value);
        expect(text).toBe(PUBLIC_FAILURE_TEXT);
        for (const secret of [e2e.oboClientId, e2e.oboClientSecret, e2e.domain, e2e.ledgerAudience, "write:ledger", userToken]) {
          expect(text.includes(secret), "tool text must not echo tenant or request details").toBe(false);
        }
        expect(description.length > 0 && text.includes(description)).toBe(false);
        expect(JWT_SHAPE.test(text)).toBe(false);
        expect(counter!.count("client_credentials")).toBe(1);
        expect(services.log).toHaveLength(0);
        expect(store.size).toBe(0);
      });
    });
  });
});
