import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryIndexedTokenStore } from "../../src/stores/memory-indexed-store.js";
import {
  TOKEN_EXCHANGE_GRANT,
  callToolJson,
  connectMcpClient,
  getUserToken,
  installFetchCounter,
  installFetchFault,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type {
  ConnectedClient,
  DelegateResult,
  DownstreamApi,
  E2eMcpServer,
  FetchCounter,
  FetchFault,
  FetchFaultHandle,
} from "./support/index.js";

const e2e = loadE2eEnv();

/** The fixed text the wrapper shows for any failed token operation (`sanitizeTokenError`). */
const GENERIC_FAILURE = "The token operation failed.";

/** A marker that must never reach an MCP client. It is planted in every injected error body. */
const UPSTREAM_SECRET = "upstream secret detail";

/**
 * Request limit and injected delay of the timeout cases. The limit is set once per server and also
 * covers the real calls that must succeed afterwards (discovery, JWKS, the recovery exchange), so
 * it has to sit well above the tenant's normal latency (exchanges take up to about 800 ms). Limits
 * of 500 ms and 1 s each made a recovery call time out in roughly one run in six.
 */
const LIMIT_MS = 2000;
const HANG_MS = 6000;

const UPSTREAM_BODY = JSON.stringify({ error: "server_error", error_description: UPSTREAM_SECRET });

/**
 * Fault injection against a real tenant, real tokens, the real handler and a real SDK client. Only
 * the injected failure is synthetic. Each case builds a fresh server: the core client caches
 * discovery metadata and the JWKS set per client at first verification, so a fault on those must
 * be installed before the server exists and before its first authenticated request.
 */
describe("e2e fault injection", () => {
  let downstream: DownstreamApi;
  let userToken: string;
  let fault: FetchFaultHandle | undefined;
  let counter: FetchCounter | undefined;
  let server: E2eMcpServer | undefined;
  let session: ConnectedClient | undefined;
  let extraSessions: ConnectedClient[] = [];

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    // Minted once, outside any counter window; memoized by the helper.
    userToken = await getUserToken(e2e);
  });

  afterEach(async () => {
    // Reverse order of installation: the counter is the outer wrapper.
    counter?.restore();
    fault?.restore();
    await session?.close();
    for (const extra of extraSessions) await extra.close();
    extraSessions = [];
    await server?.close();
    counter = undefined;
    fault = undefined;
    session = undefined;
    server = undefined;
    downstream.calls.length = 0;
  });

  afterAll(async () => {
    await downstream.close();
  });

  /** Fault first, counter second, so the counter also sees the faulted attempts. */
  function inject(match: Parameters<typeof installFetchFault>[0], spec: FetchFault, times = 1) {
    fault = installFetchFault(match, spec, { times });
    counter = installFetchCounter();
  }

  describe("token exchange failure", () => {
    const cases: Array<{ name: string; fault: FetchFault }> = [
      { name: "503", fault: { kind: "status", status: 503, body: UPSTREAM_BODY } },
      { name: "500", fault: { kind: "status", status: 500, body: UPSTREAM_BODY } },
      {
        name: "429 with Retry-After",
        fault: { kind: "status", status: 429, body: UPSTREAM_BODY, headers: { "retry-after": "1" } },
      },
      { name: "network error (TypeError)", fault: { kind: "network" } },
    ];

    it.each(cases)("$name: sanitized tool error, nothing cached, next call exchanges for real", async (spec) => {
      inject({ grantType: TOKEN_EXCHANGE_GRANT }, spec.fault);
      const store = new MemoryIndexedTokenStore();
      server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url, tokenStore: store });
      session = await connectMcpClient(server.url, userToken);
      // Warms discovery and JWKS verification so only exchanges move the counter below.
      await callToolJson(session.client, "whoami");
      counter!.reset();

      const failed = await callToolJson<string>(session.client, "delegate");
      // The SDK reports a throwing tool as an `isError` result over HTTP 200, not an HTTP error.
      // A 429 maps like any other upstream failure: the wrapper does not retry or surface Retry-After.
      expect(failed.isError).toBe(true);
      expect(failed.value).toBe(GENERIC_FAILURE);
      expect(JSON.stringify(failed.value).includes(UPSTREAM_SECRET), "tool result must not echo the upstream body").toBe(false);
      expect(fault!.injected).toBe(1);
      // One attempt only: no automatic retry inside the call.
      expect(counter!.exchanges).toBe(1);
      expect(store.size).toBe(0);
      expect(downstream.calls).toHaveLength(0);

      // The fault is exhausted: the failure was neither cached nor shared.
      const ok = await callToolJson<DelegateResult>(session.client, "delegate");
      expect(ok.isError).toBe(false);
      expect(ok.value.status).toBe(200);
      expect(ok.value.grantedScopes).toContain(e2e.downstreamScope);
      expect(counter!.exchanges).toBe(2);
      expect(store.size).toBeGreaterThan(0);
      expect(downstream.calls.map((c) => c.status)).toEqual([200]);
    });
  });

  describe("slow token endpoint", () => {
    it("a delayed exchange still completes and the call waits for it", async () => {
      const delayMs = 3000;
      inject({ grantType: TOKEN_EXCHANGE_GRANT }, { kind: "delay", ms: delayMs });
      server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url });
      session = await connectMcpClient(server.url, userToken);
      await callToolJson(session.client, "whoami");
      counter!.reset();

      const started = Date.now();
      const { isError, value } = await callToolJson<DelegateResult>(session.client, "delegate");
      const elapsed = Date.now() - started;

      // The delay is below the default request timeout, so the call waits and succeeds.
      expect(isError).toBe(false);
      expect(value.status).toBe(200);
      expect(fault!.injected).toBe(1);
      expect(counter!.exchanges).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(delayMs - 100);
    });
  });

  describe("token endpoint slower than requestTimeoutMs", () => {
    it("E-F-05: fails with a sanitized tool error near the limit, caches nothing, and the next call succeeds", async () => {
      const limitMs = LIMIT_MS;
      const store = new MemoryIndexedTokenStore();
      fault = installFetchFault({ grantType: TOKEN_EXCHANGE_GRANT }, { kind: "delay", ms: HANG_MS }, { times: 1 });
      counter = installFetchCounter();
      server = await startMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        tokenStore: store,
        requestTimeoutMs: limitMs,
      });
      session = await connectMcpClient(server.url, userToken);
      await callToolJson(session.client, "whoami");
      counter.reset();

      const started = Date.now();
      const failed = await callToolJson<string>(session.client, "delegate");
      const elapsed = Date.now() - started;

      expect(failed.isError).toBe(true);
      expect(failed.value).toBe(GENERIC_FAILURE);
      expect(fault.injected).toBe(1);
      expect(elapsed, "the call must be cut off by the limit, not wait for the slow endpoint").toBeLessThan(limitMs * 2);
      expect(store.size).toBe(0);
      expect(downstream.calls).toHaveLength(0);

      // The fault is exhausted: the timeout was neither cached nor shared.
      const ok = await callToolJson<DelegateResult>(session.client, "delegate");
      expect(ok.isError).toBe(false);
      expect(ok.value.status).toBe(200);
      expect(store.size).toBeGreaterThan(0);
    });
  });

  describe("concurrent callers and a hung token endpoint", () => {
    const limitMs = LIMIT_MS;
    const hangMs = HANG_MS;
    const callers = 5;

    /** Opens `callers` MCP sessions that all present the same caller token, as one user in one session would. */
    async function connectCallers(): Promise<ConnectedClient[]> {
      const opened: ConnectedClient[] = [];
      for (let i = 0; i < callers; i += 1) opened.push(await connectMcpClient(server!.url, userToken));
      extraSessions.push(...opened);
      return opened;
    }

    it("E-F-07: callers that share one hung exchange fail together after one upstream call, then the next call recovers", async () => {
      const store = new MemoryIndexedTokenStore();
      fault = installFetchFault({ grantType: TOKEN_EXCHANGE_GRANT }, { kind: "delay", ms: hangMs }, { times: 1 });
      counter = installFetchCounter();
      server = await startMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        tokenStore: store,
        requestTimeoutMs: limitMs,
      });
      const sessions = await connectCallers();
      await callToolJson(sessions[0]!.client, "whoami");
      counter.reset();

      const started = Date.now();
      const results = await Promise.all(sessions.map((s) => callToolJson<string>(s.client, "delegate")));
      const elapsed = Date.now() - started;

      for (const result of results) {
        expect(result.isError).toBe(true);
        expect(result.value).toBe(GENERIC_FAILURE);
      }
      // One upstream attempt served every caller: concurrent callers do not each hit the tenant.
      expect(fault.injected).toBe(1);
      expect(counter.exchanges).toBe(1);
      expect(elapsed, "every caller must be released by the limit, not by the slow endpoint").toBeLessThan(hangMs);
      expect(store.size).toBe(0);
      expect(downstream.calls).toHaveLength(0);

      const ok = await callToolJson<DelegateResult>(sessions[0]!.client, "delegate");
      expect(ok.isError).toBe(false);
      expect(ok.value.status).toBe(200);
      expect(counter.exchanges).toBe(2);
      expect(store.size).toBeGreaterThan(0);
    });

    it("E-F-08: a timed out exchange poisons neither the store nor the single-flight slot", async () => {
      const store = new MemoryIndexedTokenStore();
      fault = installFetchFault({ grantType: TOKEN_EXCHANGE_GRANT }, { kind: "delay", ms: hangMs }, { times: 1 });
      counter = installFetchCounter();
      server = await startMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        tokenStore: store,
        requestTimeoutMs: limitMs,
      });
      const sessions = await connectCallers();
      await callToolJson(sessions[0]!.client, "whoami");
      counter.reset();

      const failed = await callToolJson<string>(sessions[0]!.client, "delegate");
      expect(failed.isError).toBe(true);
      expect(failed.value).toBe(GENERIC_FAILURE);
      expect(store.size).toBe(0);

      // A burst right after the failure: the failed flight must not be remembered, so the callers
      // share one fresh exchange and all succeed.
      const burst = await Promise.all(sessions.map((s) => callToolJson<DelegateResult>(s.client, "delegate")));
      for (const result of burst) {
        expect(result.isError).toBe(false);
        expect(result.value.status).toBe(200);
      }
      expect(counter.exchanges).toBe(2);
      expect(store.size).toBeGreaterThan(0);

      // The good result is cached and served; nothing stale from the timeout is in the way.
      const cached = await callToolJson<DelegateResult>(sessions[1]!.client, "delegate");
      expect(cached.isError).toBe(false);
      expect(cached.value.status).toBe(200);
      expect(counter.exchanges).toBe(2);
    });
  });

  describe("slow JWKS on first verification", () => {
    // Pinned behaviour, like the cases below: a JWKS fetch cut off by the request limit surfaces as
    // an invalid_token 401, and the ingress does not hang for the full delay. See the note on that
    // group for why a 5xx would arguably be more correct.
    it("E-F-06 (pinned behavior): 401 invalid_token within the limit, then the same token verifies", async () => {
      const limitMs = LIMIT_MS;
      const delayMs = HANG_MS;
      fault = installFetchFault({ urlIncludes: "/.well-known/jwks.json", method: "GET" }, { kind: "delay", ms: delayMs }, { times: 1 });
      server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url, requestTimeoutMs: limitMs });

      const started = Date.now();
      const failed = await postInitialize(server.url, `Bearer ${userToken}`);
      const elapsed = Date.now() - started;

      expect(fault.injected).toBe(1);
      expect(failed.status).toBe(401);
      expect(failed.challenge?.scheme).toBe("Bearer");
      expect(failed.challenge?.params.error).toBe("invalid_token");
      // Bounded by twice the limit (discovery plus the cut-off JWKS fetch), well under the delay and under
      // the 5 s the JWKS library would wait on its own, so only the wrapper's limit can satisfy it.
      expect(elapsed, "the verification must be cut off by the limit, not wait for the slow JWKS").toBeLessThan(limitMs * 2);

      // The fault is exhausted and the failed fetch was not cached.
      const retried = await postInitialize(server.url, `Bearer ${userToken}`);
      expect(retried.status).toBe(200);
      expect(retried.challenge).toBeNull();
    });
  });

  describe("ingress dependency failure on first verification", () => {
    // Observed behaviour: the core reports ANY verification failure, including an unreachable or
    // failing JWKS or discovery endpoint, as an invalid_token error, so ingress answers 401 with a
    // Bearer challenge. A 500 would arguably be more correct: the token is fine and an
    // infrastructure failure on our side tells the client to discard a valid credential and
    // re-authenticate. These tests pin the current behaviour so a change is a conscious one.
    const cases: Array<{ name: string; urlIncludes: string; fault: FetchFault }> = [
      {
        name: "JWKS 503",
        urlIncludes: "/.well-known/jwks.json",
        fault: { kind: "status", status: 503, body: UPSTREAM_BODY },
      },
      { name: "JWKS network error", urlIncludes: "/.well-known/jwks.json", fault: { kind: "network" } },
      {
        name: "discovery 503",
        urlIncludes: "/.well-known/openid-configuration",
        fault: { kind: "status", status: 503, body: UPSTREAM_BODY },
      },
      {
        name: "discovery network error",
        urlIncludes: "/.well-known/openid-configuration",
        fault: { kind: "network" },
      },
    ];

    it.each(cases)("$name: 401 invalid_token with a Bearer challenge, then recovers", async (spec) => {
      fault = installFetchFault({ urlIncludes: spec.urlIncludes, method: "GET" }, spec.fault, { times: 1 });
      // Fresh server: the JWKS set and discovery metadata are cached per client after first success.
      server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url });

      const failed = await postInitialize(server.url, `Bearer ${userToken}`);
      expect(fault.injected).toBe(1);
      expect(failed.status).toBe(401);
      expect(failed.challenge?.scheme).toBe("Bearer");
      expect(failed.challenge?.params.error).toBe("invalid_token");
      expect((failed.wwwAuthenticate ?? "").includes(UPSTREAM_SECRET), "challenge must not echo the upstream body").toBe(false);

      // The fault is exhausted and a failed fetch is not cached: the same token now verifies.
      const retried = await postInitialize(server.url, `Bearer ${userToken}`);
      expect(retried.status).toBe(200);
      expect(retried.challenge).toBeNull();
    });
  });
});
