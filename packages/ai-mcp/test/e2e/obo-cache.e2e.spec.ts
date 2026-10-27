import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
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
import type {
  ConnectedClient,
  DelegateResult,
  DownstreamApi,
  DownstreamClaimsBody,
  E2eMcpServer,
  FetchCounter,
} from "./support/index.js";

const e2e = loadE2eEnv();

/** A scope the downstream API does not define. The tenant drops it, which makes a real partial grant. */
const UNDEFINED_SCOPE = "e2e:undefined";

/** The message a downscoped exchange carries on the tool result (see `DownscopedTokenError`). */
const DOWNSCOPE_MESSAGE =
  "Exchanged token did not include all requested scopes.";

describe("e2e on-behalf-of cache behaviour", () => {
  let downstream: DownstreamApi;
  let counter: FetchCounter | undefined;
  let server: E2eMcpServer | undefined;
  let session: ConnectedClient | undefined;
  let userToken: string;

  beforeAll(async () => {
    downstream = await startDownstreamApi({
      domain: e2e.domain,
      audience: e2e.downstreamAudience,
    });
    userToken = await getUserToken(e2e);
  });

  beforeEach(() => {
    // The counter goes in before the server so any fetch reference taken at construction is wrapped.
    counter = installFetchCounter();
  });

  afterEach(async () => {
    counter?.restore();
    await session?.close();
    await server?.close();
    session = undefined;
    server = undefined;
    downstream.calls.length = 0;
  });

  afterAll(async () => {
    await downstream.close();
  });

  async function boot(store: MemoryIndexedTokenStore) {
    server = await startMcpServer({
      env: e2e,
      downstreamUrl: downstream.url,
      tokenStore: store,
    });
    session = await connectMcpClient(server.url, userToken);
    // Warm the JWKS and verification path so only exchanges are counted below.
    await callToolJson(session.client, "whoami");
    counter!.reset();
    downstream.calls.length = 0;
    return session.client;
  }

  it("strict mode reuses a token for the same scope set and exchanges again for a different one", async () => {
    const store = new MemoryIndexedTokenStore();
    const client = await boot(store);

    for (let i = 0; i < 2; i += 1) {
      const { isError, value } = await callToolJson<DelegateResult>(
        client,
        "delegate",
        { scope: "work:read" },
      );
      expect(isError).toBe(false);
      expect(value.status).toBe(200);
      expect(value.grantedScopes).toContain("work:read");
    }
    expect(counter!.exchanges).toBe(1);
    expect(downstream.calls.map((c) => c.status)).toEqual([200, 200]);

    const wider = await callToolJson<DelegateResult>(client, "delegate", {
      scope: "work:read work:write",
    });
    expect(wider.isError).toBe(false);
    expect(wider.value.status).toBe(200);
    expect([...wider.value.grantedScopes].sort()).toEqual([
      "work:read",
      "work:write",
    ]);
    expect(
      (wider.value.body as unknown as DownstreamClaimsBody).scope
        ?.split(" ")
        .sort(),
    ).toEqual(["work:read", "work:write"]);
    expect(counter!.exchanges).toBe(2);
    expect(downstream.calls.map((c) => c.status)).toEqual([200, 200, 200]);
    expect(store.size).toBe(2);
  });

  // The single-flight key is built from the exchanging client, the verified caller (issuer, subject,
  // client, session) and the requested audience and scopes, and the flight map lives on the parent
  // McpClient. The server is stateless, so ten calls on one MCP session are ten independent requests
  // that each verify the same token and share one flight. A store is present, so a call that arrives
  // after the flight settled is answered from the cache; either way one exchange is the only correct count.
  it("collapses ten concurrent identical calls into one exchange", async () => {
    const store = new MemoryIndexedTokenStore();
    const client = await boot(store);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        callToolJson<DelegateResult>(client, "delegate", {
          scope: "work:read",
        }),
      ),
    );

    expect(results).toHaveLength(10);
    for (const { isError, value } of results) {
      expect(isError).toBe(false);
      expect(value.status).toBe(200);
      expect(value.grantedScopes).toContain("work:read");
    }
    expect(counter!.exchanges).toBe(1);
    expect(downstream.calls).toHaveLength(10);
    expect(downstream.calls.every((c) => c.status === 200)).toBe(true);
    expect(store.size).toBe(1);
  });

  // Without a store nothing is cached, so the only thing that can collapse concurrent calls is
  // the single flight. The flight is registered synchronously inside `SingleFlight.run`
  // (src/single-flight.ts), before the first await, so calls that reach `run` while the first
  // exchange is still in flight join it. Over HTTP the count is not strictly deterministic: each
  // request first verifies the token, and a request that reached `run` only after the exchange
  // settled would start a second one. All ten requests are started before any is awaited, and a
  // live exchange takes far longer than the spread between their arrivals, so exactly one is the
  // expected count; a flaky count above one would be a real finding, not something to loosen.
  describe("single-flight without a store", () => {
    async function bootNoStore() {
      server = await startMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        tokenStore: null,
      });
      session = await connectMcpClient(server.url, userToken);
      await callToolJson(session.client, "whoami");
      counter!.reset();
      downstream.calls.length = 0;
      return session.client;
    }

    it("shares one exchange between concurrent calls, does not cache afterwards, and separates scope sets", async () => {
      const client = await bootNoStore();

      // Start all ten calls before awaiting any of them.
      const pending = Array.from({ length: 10 }, () =>
        callToolJson<DelegateResult>(client, "delegate", {
          scope: "work:read",
        }),
      );
      const results = await Promise.all(pending);

      expect(results).toHaveLength(10);
      for (const { isError, value } of results) {
        expect(isError).toBe(false);
        expect(value.status).toBe(200);
        expect(value.grantedScopes).toContain("work:read");
      }
      expect(counter!.exchanges).toBe(1);
      expect(downstream.calls).toHaveLength(10);
      expect(downstream.calls.every((c) => c.status === 200)).toBe(true);

      // After the flight settled there is no store to answer from, so the next call exchanges again.
      const after = await callToolJson<DelegateResult>(client, "delegate", {
        scope: "work:read",
      });
      expect(after.isError).toBe(false);
      expect(after.value.status).toBe(200);
      expect(counter!.exchanges).toBe(2);

      // Different scope sets never share a flight: five calls each, two exchanges.
      counter!.reset();
      const mixed = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          callToolJson<DelegateResult>(client, "delegate", {
            scope: i % 2 === 0 ? "work:read" : "work:read work:write",
          }),
        ),
      );
      for (const { isError, value } of mixed) {
        expect(isError).toBe(false);
        expect(value.status).toBe(200);
      }
      expect(counter!.exchanges).toBe(2);
    });
  });

  it("rejects a partial grant with a sanitized error, never calls the downstream API, and caches under the granted scopes", async () => {
    const store = new MemoryIndexedTokenStore();
    const client = await boot(store);

    const requested = `work:read ${UNDEFINED_SCOPE}`;
    const { isError, value } = await callToolJson<unknown>(client, "delegate", {
      scope: requested,
    });

    expect(isError).toBe(true);
    const text = String(value);
    expect(
      text.includes(DOWNSCOPE_MESSAGE),
      "tool text must carry the downscope message",
    ).toBe(true);
    expect(
      text.includes(UNDEFINED_SCOPE),
      "tool text must not echo the undefined scope",
    ).toBe(false);
    expect(
      text.includes("work:read"),
      "tool text must not echo granted scopes",
    ).toBe(false);
    expect(
      /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./.test(text),
      "tool text must not contain a JWT",
    ).toBe(false);
    expect(
      /\n\s+at /.test(text),
      "tool text must not contain a stack trace",
    ).toBe(false);
    expect(
      text.includes(userToken),
      "tool text must not contain the user token",
    ).toBe(false);
    expect(downstream.calls).toHaveLength(0);
    expect(counter!.exchanges).toBe(1);

    // Documented behaviour: the narrower token is cached under the scopes Auth0 granted, so a later
    // request for exactly those scopes is a cache hit and does not exchange again.
    expect(store.size).toBe(1);
    const reuse = await callToolJson<DelegateResult>(client, "delegate", {
      scope: "work:read",
    });
    expect(reuse.isError).toBe(false);
    expect(reuse.value.status).toBe(200);
    expect(reuse.value.grantedScopes).toEqual(["work:read"]);
    expect(counter!.exchanges).toBe(1);
    expect(downstream.calls.map((c) => c.status)).toEqual([200]);

    // The partial request itself is not served from that entry: it still fails.
    const again = await callToolJson<unknown>(client, "delegate", {
      scope: requested,
    });
    expect(again.isError).toBe(true);
    expect(downstream.calls).toHaveLength(1);
  });
});
