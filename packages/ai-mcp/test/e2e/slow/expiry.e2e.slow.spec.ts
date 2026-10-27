import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryIndexedTokenStore } from "../../../src/stores/memory-indexed-store.js";
import {
  SHORT_VARS,
  callToolJson,
  connectMcpClient,
  decodeClaims,
  getUserToken,
  installFetchCounter,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
} from "../support/index.js";
import type {
  ConnectedClient,
  DelegateResult,
  DownstreamApi,
  E2eEnv,
  E2eMcpServer,
  FetchCounter,
} from "../support/index.js";
import type { CachedToken } from "../../../src/index.js";

const e2e = loadE2eEnv(SHORT_VARS);

/**
 * Seconds before `exp` during which the core treats a cached OBO token as stale and exchanges
 * again. The constant is internal to the core client (not exported), so it is mirrored here and
 * the specs below assert the behavior it produces against the real tenant.
 */
const CACHE_LEEWAY_SECONDS = 5;

/** Extra wait past `exp` so a clock difference of about a second cannot flip an assertion. */
const PAST_EXP_MARGIN_MS = 2000;

/** Scope of the Short MCP API the caller token carries. */
const CALLER_SCOPE = "tool:whoami";

/** Scope of the Short downstream API the server exchanges for. */
const SHORT_DOWNSTREAM_SCOPE = "read:short";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Waits on the real clock until `epochMs`. */
const sleepUntil = (epochMs: number) => sleep(epochMs - Date.now());

/** A store that remembers the expiry of every token written, so a spec can compare it to the token. */
class RecordingStore extends MemoryIndexedTokenStore {
  readonly writes: number[] = [];
  override async set(key: string, value: CachedToken): Promise<void> {
    this.writes.push(value.expiresAt);
    return super.set(key, value);
  }
}

/**
 * The env for the exchange scenarios: the normal MCP API and exchange client, but the downstream
 * is the short-lived API, so the exchanged token lives 30 seconds while the caller token (24
 * hours) outlives it. That is the only arrangement in which one caller token can see its own
 * cached exchange expire: the cache is keyed by the caller token, so a short-lived caller token
 * always ends before the exchange it caused.
 */
function exchangeEnv(base: E2eEnv): E2eEnv {
  return { ...base, downstreamAudience: base.shortDownstreamAudience, downstreamScope: SHORT_DOWNSTREAM_SCOPE };
}

/** Real caller token for the Short MCP API, fresh because the clock is the point of E-X-01. */
function callerToken(): Promise<string> {
  return getUserToken(e2e, { audience: e2e.shortMcpAudience, scope: CALLER_SCOPE, fresh: true });
}

/**
 * Expiry over time against a real tenant and the real clock, with 30 second token lifetimes (the
 * lifetime is read from the tenant configuration and asserted, never assumed). No fake timers.
 */
describe("e2e expiry over time", () => {
  let downstream: DownstreamApi;
  let counter: FetchCounter | undefined;
  let server: E2eMcpServer | undefined;
  let sessions: ConnectedClient[] = [];

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.shortDownstreamAudience });
  });

  afterEach(async () => {
    counter?.restore();
    for (const session of sessions) await session.close();
    await server?.close();
    counter = undefined;
    server = undefined;
    sessions = [];
    downstream.calls.length = 0;
  });

  afterAll(async () => {
    await downstream.close();
  });

  /** One delegate call over an open session. */
  async function delegate(session: ConnectedClient): Promise<DelegateResult> {
    const { isError, value } = await callToolJson<DelegateResult>(session.client, "delegate");
    expect(isError).toBe(false);
    expect(value.status).toBe(200);
    return value;
  }

  /** Starts a server on the exchange env with a recording store and connects one caller token to it. */
  async function startExchangeSession(): Promise<{ store: RecordingStore; session: ConnectedClient }> {
    const store = new RecordingStore();
    counter = installFetchCounter();
    server = await startMcpServer({ env: exchangeEnv(e2e), downstreamUrl: downstream.url, tokenStore: store });
    // One caller token for the whole scenario: the cache entry belongs to it.
    const session = await connectMcpClient(server.url, await getUserToken(e2e, { fresh: true }));
    sessions.push(session);
    return { store, session };
  }

  /** The `exp` of the exchanged token the downstream saw on its latest accepted call. */
  function lastDownstreamExp(): number {
    const accepted = downstream.calls.filter((c) => c.status === 200);
    return accepted[accepted.length - 1]!.claims!["exp"] as number;
  }

  it("E-X-01: a caller token is accepted before exp and rejected with 401 invalid_token after it", async () => {
    server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url, audience: e2e.shortMcpAudience });
    const token = await callerToken();
    const claims = decodeClaims(token);
    const exp = claims["exp"] as number;

    // The lifetime really is what the tenant was configured with, so the wait below is meaningful.
    expect(exp - (claims["iat"] as number)).toBe(e2e.shortLifetimeSeconds);

    const before = await postInitialize(server.url, `Bearer ${token}`);
    expect(before.status).toBe(200);

    await sleepUntil(exp * 1000 + PAST_EXP_MARGIN_MS);

    const after = await postInitialize(server.url, `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.challenge?.scheme).toBe("Bearer");
    expect(after.challenge?.params.error).toBe("invalid_token");

    // The rejection is about the old token, not the server: a fresh token is accepted.
    const fresh = await postInitialize(server.url, `Bearer ${await callerToken()}`);
    expect(fresh.status).toBe(200);
  });

  it("E-X-02: a cached OBO token past its exp is replaced by a new exchange for the same caller", async () => {
    const { store, session } = await startExchangeSession();

    await delegate(session);
    expect(counter!.exchanges).toBe(1);
    const firstExp = lastDownstreamExp();
    // The cache entry lives exactly as long as the token it holds.
    expect(store.writes).toEqual([firstExp]);

    // Control: the same caller token is served from the cache, so the exchange after the wait is
    // caused by expiry and by nothing else.
    await delegate(session);
    expect(counter!.exchanges).toBe(1);

    await sleepUntil(firstExp * 1000 + PAST_EXP_MARGIN_MS);

    await delegate(session);
    expect(counter!.exchanges).toBe(2);
    const secondExp = lastDownstreamExp();
    expect(secondExp).toBeGreaterThan(firstExp);
    expect(store.writes).toEqual([firstExp, secondExp]);
  });

  it("E-X-03: a cached OBO token inside the leeway window is not served", async () => {
    const { store, session } = await startExchangeSession();

    await delegate(session);
    expect(counter!.exchanges).toBe(1);
    const exp = lastDownstreamExp();

    // Well before the window the entry is served.
    await delegate(session);
    expect(counter!.exchanges).toBe(1);

    // A few seconds before exp the token is still valid and still in the store, but it is inside
    // the leeway window, so it must not be handed out.
    await sleepUntil((exp - (CACHE_LEEWAY_SECONDS - 2)) * 1000);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(store.size).toBeGreaterThan(0);

    await delegate(session);
    expect(counter!.exchanges).toBe(2);
    expect(lastDownstreamExp()).toBeGreaterThan(exp);
  });
});
