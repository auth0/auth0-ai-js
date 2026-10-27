import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import {
  callToolJson,
  connectMcpClient,
  getUserToken,
  installFetchCounter,
  loadE2eEnv,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { ConnectedClient, DownstreamApi, E2eMcpServer, FetchCounter } from "./support/index.js";

const e2e = loadE2eEnv();

/** The fixed text every sanitized token failure carries (see `GENERIC_FAILURE_MESSAGE`). */
const PUBLIC_FAILURE_TEXT = "The token operation failed.";

const UNKNOWN_CONNECTION = "no-such-connection-e2e";

/** What the tenant answered to one token endpoint POST. The description is kept only to prove it never leaks. */
interface TokenResponseTap {
  grant: string;
  status: number;
  error: string | null;
  description: string | null;
}

/** Records grant type, status and `error` of every token endpoint answer. Install after the counter. */
function installResponseTap(): { responses: TokenResponseTap[]; restore(): void } {
  const previous = globalThis.fetch;
  const responses: TokenResponseTap[] = [];
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await previous(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/oauth/token")) {
      const body = init?.body;
      const grant =
        (body instanceof URLSearchParams ? body : new URLSearchParams(typeof body === "string" ? body : "")).get(
          "grant_type",
        ) ?? "unknown";
      let error: string | null = null;
      let description: string | null = null;
      try {
        const parsed = (await response.clone().json()) as { error?: unknown; error_description?: unknown };
        error = typeof parsed.error === "string" ? parsed.error : null;
        description = typeof parsed.error_description === "string" ? parsed.error_description : null;
      } catch {
        // Non-JSON answers keep null fields.
      }
      responses.push({ grant, status: response.status, error, description });
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

/** Names of the sensitive values found in `text`; labels only, so a failure never prints a secret. */
function leaks(text: string, sensitive: Record<string, string | null>): string[] {
  const found = Object.entries(sensitive)
    .filter(([, value]) => value !== null && value.length > 0 && text.includes(value))
    .map(([label]) => label);
  if (/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./.test(text)) found.push("jwt-shaped string");
  if (/\n\s+at /.test(text)) found.push("stack trace");
  return found;
}

/** What the tenant really answers for an unknown Token Vault connection, observed live. Not secret. */
const OBSERVED = {
  grant: "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
  status: 403,
  error: "unauthorized_client",
};

describe("e2e Token Vault getTokenForService", () => {
  let downstream: DownstreamApi;
  let counter: FetchCounter | undefined;
  let tap: ReturnType<typeof installResponseTap> | undefined;
  let server: E2eMcpServer | undefined;
  let session: ConnectedClient | undefined;
  let userToken: string;
  const store = new MemoryIndexedTokenStore();

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await getUserToken(e2e);
  });

  beforeEach(async () => {
    counter = installFetchCounter();
    tap = installResponseTap();
    server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url, tokenStore: store });
    session = await connectMcpClient(server.url, userToken);
    // Warm the JWKS and discovery path so only Token Vault requests are counted below.
    await callToolJson(session.client, "whoami");
    counter.reset();
    tap.responses.length = 0;
  });

  afterEach(async () => {
    tap?.restore();
    counter?.restore();
    await session?.close();
    await server?.close();
    session = undefined;
    server = undefined;
  });

  afterAll(async () => {
    await downstream.close();
  });

  function expectSanitized(text: string, description: string | null) {
    expect(text === PUBLIC_FAILURE_TEXT, "tool text must be the generic public failure text").toBe(true);
    expect(
      leaks(text, {
        domain: e2e.domain,
        "OBO client id": e2e.oboClientId,
        "OBO client secret": e2e.oboClientSecret,
        "user token": userToken,
        "tenant error description": description,
        "connection name": UNKNOWN_CONNECTION,
        "tenant error code": "access_denied",
      }),
    ).toEqual([]);
  }

  it("an unknown connection is rejected by the tenant, sanitized, and never cached", async () => {
    const client = session!.client;

    const first = await callToolJson<unknown>(client, "service", { connection: UNKNOWN_CONNECTION });
    expect(first.isError).toBe(true);
    expect(tap!.responses).toHaveLength(1);
    const real = tap!.responses[0]!;
    console.info(`observed vault grant=${real.grant} status=${real.status} error=${real.error}`);
    expect({ grant: real.grant, status: real.status, error: real.error }).toEqual(OBSERVED);
    expect(Object.values(counter!.byGrant).reduce((a, b) => a + b, 0)).toBe(1);
    expect(counter!.count(real.grant)).toBe(1);
    // It is the Token Vault grant, not the on-behalf-of exchange.
    expect(counter!.exchanges).toBe(0);
    expectSanitized(String(first.value), real.description);
    expect(store.size).toBe(0);

    // The second call asks the tenant again: no caching of the failure.
    const second = await callToolJson<unknown>(client, "service", { connection: UNKNOWN_CONNECTION });
    expect(second.isError).toBe(true);
    expect(counter!.count(real.grant)).toBe(2);
    expect(tap!.responses).toHaveLength(2);
    expectSanitized(String(second.value), tap!.responses[1]!.description);
    expect(store.size).toBe(0);
  });

  it("an unknown connection with a login hint gets the same sanitized rejection", async () => {
    const hint = "e2e-login-hint@example.invalid";
    const result = await callToolJson<unknown>(session!.client, "service", {
      connection: UNKNOWN_CONNECTION,
      loginHint: hint,
    });
    expect(result.isError).toBe(true);
    expect(tap!.responses).toHaveLength(1);
    const real = tap!.responses[0]!;
    expect({ grant: real.grant, status: real.status, error: real.error }).toEqual(OBSERVED);
    expect(Object.values(counter!.byGrant).reduce((a, b) => a + b, 0)).toBe(1);
    const text = String(result.value);
    expectSanitized(text, real.description);
    expect(text.includes(hint)).toBe(false);
    expect(store.size).toBe(0);
  });

  it.todo("returns a federated access token for a linked account (needs a configured Token Vault connection and a linked account for the test user)");
});
