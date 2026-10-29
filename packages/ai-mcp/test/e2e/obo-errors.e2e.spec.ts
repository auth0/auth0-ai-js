import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import {
  callToolJson,
  connectMcpClient,
  getClientCredentialsToken,
  getUserToken,
  LIMITED_CLIENT_VARS,
  installFetchCounter,
  loadE2eEnv,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { ConnectedClient, DelegateResult, DownstreamApi, E2eMcpServer, FetchCounter } from "./support/index.js";

const e2e = loadE2eEnv(LIMITED_CLIENT_VARS);

/** The fixed text every sanitized token failure carries (see `GENERIC_FAILURE_MESSAGE`). */
const PUBLIC_FAILURE_TEXT = "The token operation failed.";

/** An audience that cannot exist on any tenant (reserved `.invalid` top level domain). */
const UNDEFINED_AUDIENCE = "https://e2e-undefined-audience.invalid/";

/** What the tenant answered to one token endpoint POST. The description is kept only to prove it never leaks. */
interface TokenResponseTap {
  status: number;
  error: string | null;
  description: string | null;
}

/**
 * Records status and `error` of every token endpoint answer. Wrap order: install the counter first,
 * then this tap, and restore in reverse order.
 */
function installResponseTap(): { responses: TokenResponseTap[]; restore(): void } {
  const previous = globalThis.fetch;
  const responses: TokenResponseTap[] = [];
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await previous(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/oauth/token")) {
      let error: string | null = null;
      let description: string | null = null;
      try {
        const body = (await response.clone().json()) as { error?: unknown; error_description?: unknown };
        error = typeof body.error === "string" ? body.error : null;
        description = typeof body.error_description === "string" ? body.error_description : null;
      } catch {
        // Non-JSON answers keep null fields.
      }
      responses.push({ status: response.status, error, description });
    }
    return response;
  }) as typeof fetch;
  globalThis.fetch = wrapper;
  return {
    responses,
    restore() {
      if (globalThis.fetch === wrapper) globalThis.fetch = previous;
    },
  };
}

/**
 * Names of the sensitive values found in `text`. Returns labels only, so a failing assertion never
 * prints the text or a secret.
 */
function leaks(text: string, sensitive: Record<string, string | null>): string[] {
  const found = Object.entries(sensitive)
    .filter(([, value]) => value !== null && value.length > 0 && text.includes(value))
    .map(([label]) => label);
  if (/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./.test(text)) found.push("jwt-shaped string");
  if (/\n\s+at /.test(text)) found.push("stack trace");
  return found;
}

/**
 * What the tenant really answers for each rejection, observed live. Not secret. If the tenant
 * changes behaviour these assertions fail and the unit mocks should be compared again.
 */
const OBSERVED = {
  undefinedAudience: { status: 400, error: "invalid_target" },
  wrongSecret: { status: 401, error: "access_denied" },
  machineSubject: { status: 400, error: "invalid_request" },
};

describe("e2e on-behalf-of rejections by the tenant", () => {
  let downstream: DownstreamApi;
  let counter: FetchCounter | undefined;
  let tap: ReturnType<typeof installResponseTap> | undefined;
  let servers: E2eMcpServer[] = [];
  let sessions: ConnectedClient[] = [];
  let userToken: string;
  let machineToken: string;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await getUserToken(e2e);
    // A token for the MCP API that belongs to a machine client: it carries no user, so the tenant has no
    // user to act for.
    machineToken = await getClientCredentialsToken(e2e, {
      audience: e2e.mcpAudience,
      scope: "tool:whoami",
      clientId: e2e.limitedClientId,
      clientSecret: e2e.limitedClientSecret,
    });
  });

  beforeEach(() => {
    counter = installFetchCounter();
    tap = installResponseTap();
  });

  afterEach(async () => {
    tap?.restore();
    counter?.restore();
    for (const session of sessions) await session.close();
    for (const server of servers) await server.close();
    sessions = [];
    servers = [];
    downstream.calls.length = 0;
  });

  afterAll(async () => {
    await downstream.close();
  });

  async function boot(store: MemoryIndexedTokenStore, clientSecret?: string, token?: string) {
    const server = await startMcpServer({
      env: e2e,
      downstreamUrl: downstream.url,
      tokenStore: store,
      ...(clientSecret !== undefined && { clientSecret }),
    });
    servers.push(server);
    const session = await connectMcpClient(server.url, token ?? userToken);
    sessions.push(session);
    // Warm the JWKS and discovery path so only exchanges are counted below.
    await callToolJson(session.client, "whoami");
    counter!.reset();
    tap!.responses.length = 0;
    downstream.calls.length = 0;
    return session.client;
  }

  function expectSanitized(text: string, tenantDescription: string | null, extra: Record<string, string> = {}) {
    expect(text === PUBLIC_FAILURE_TEXT, "tool text must be the generic public failure text").toBe(true);
    expect(
      leaks(text, {
        domain: e2e.domain,
        "OBO client id": e2e.oboClientId,
        "OBO client secret": e2e.oboClientSecret,
        "login client id": e2e.loginClientId,
        "user token": userToken,
        "tenant error description": tenantDescription,
        "tenant error code": "access_denied",
        "invalid_client code": "invalid_client",
        ...extra,
      }),
    ).toEqual([]);
  }

  async function expectRecovery(client: Awaited<ReturnType<typeof boot>>, store: MemoryIndexedTokenStore) {
    counter!.reset();
    const ok = await callToolJson<DelegateResult>(client, "delegate");
    expect(ok.isError).toBe(false);
    expect(ok.value.status).toBe(200);
    expect(counter!.exchanges).toBe(1);
    expect(downstream.calls).toHaveLength(1);
    expect(store.size).toBe(1);
  }

  it("an audience that does not exist on the tenant is rejected, sanitized and not cached", async () => {
    const store = new MemoryIndexedTokenStore();
    const client = await boot(store);

    const first = await callToolJson<unknown>(client, "delegate", { audience: UNDEFINED_AUDIENCE });
    expect(first.isError).toBe(true);
    expect(counter!.exchanges).toBe(1);
    expect(tap!.responses).toHaveLength(1);
    const real = tap!.responses[0]!;
    console.info(`observed undefinedAudience status=${real.status} error=${real.error}`);
    expect({ status: real.status, error: real.error }).toEqual(OBSERVED.undefinedAudience);
    expectSanitized(String(first.value), real.description);
    expect(downstream.calls).toHaveLength(0);
    expect(store.size).toBe(0);

    // A second identical call hits the tenant again: the failure was not remembered.
    const second = await callToolJson<unknown>(client, "delegate", { audience: UNDEFINED_AUDIENCE });
    expect(second.isError).toBe(true);
    expect(counter!.exchanges).toBe(2);
    expect(store.size).toBe(0);

    await expectRecovery(client, store);
  });

  it("a subject token that belongs to a machine client is rejected, sanitized and not cached", async () => {
    const store = new MemoryIndexedTokenStore();
    const client = await boot(store, undefined, machineToken);

    const result = await callToolJson<unknown>(client, "delegate");
    expect(result.isError).toBe(true);
    expect(counter!.exchanges).toBe(1);
    expect(tap!.responses).toHaveLength(1);
    const real = tap!.responses[0]!;
    console.info(`observed machineSubject status=${real.status} error=${real.error}`);
    expect({ status: real.status, error: real.error }).toEqual(OBSERVED.machineSubject);
    expectSanitized(String(result.value), real.description, { "machine token": machineToken });
    expect(downstream.calls).toHaveLength(0);
    expect(store.size).toBe(0);

    // Recovery is the same user-token flow on a fresh server.
    const goodStore = new MemoryIndexedTokenStore();
    const goodClient = await boot(goodStore);
    await expectRecovery(goodClient, goodStore);
  });

  it("a wrong OBO client secret is rejected, sanitized and not cached", async () => {
    const wrongSecret = `wrong-${randomBytes(18).toString("hex")}`;
    const badStore = new MemoryIndexedTokenStore();
    const badClient = await boot(badStore, wrongSecret);

    const first = await callToolJson<unknown>(badClient, "delegate");
    expect(first.isError).toBe(true);
    expect(counter!.exchanges).toBe(1);
    expect(tap!.responses).toHaveLength(1);
    const real = tap!.responses[0]!;
    console.info(`observed wrongSecret status=${real.status} error=${real.error}`);
    expect({ status: real.status, error: real.error }).toEqual(OBSERVED.wrongSecret);
    expectSanitized(String(first.value), real.description, { "wrong secret": wrongSecret });
    expect(downstream.calls).toHaveLength(0);
    expect(badStore.size).toBe(0);

    // This server can never succeed, so recovery is shown by it asking the tenant again (nothing
    // cached) and, below, by a correctly configured server for the same user.
    const second = await callToolJson<unknown>(badClient, "delegate");
    expect(second.isError).toBe(true);
    expect(counter!.exchanges).toBe(2);
    expect(badStore.size).toBe(0);

    const goodStore = new MemoryIndexedTokenStore();
    const goodClient = await boot(goodStore);
    await expectRecovery(goodClient, goodStore);
  });
});
