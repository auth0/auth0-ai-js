import { MemoryIndexedTokenStore } from "@auth0/ai-mcp";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  SHORT_VARS,
  callOnSession,
  callTool,
  connect,
  decodeClaims,
  describeLive,
  firstUser,
  getUserToken,
  installFetchCounter,
  postInitialize,
  startDownstreamApi,
  startFastMcpServer,
  subjectOf,
} from "../support/index.js";
import type {
  DelegateResult,
  DownstreamApi,
  E2eEnv,
  FastMcpServer,
  FetchCounter,
  Session,
  WhoamiResult,
} from "../support/index.js";

/** Extra wait past `exp` so a clock difference of about a second cannot flip an assertion. */
const PAST_EXP_MARGIN_MS = 2000;

/** Scope of the short MCP API the caller token carries. */
const CALLER_SCOPE = "tool:whoami";

/** Scope of the short downstream API the server exchanges for. */
const SHORT_DOWNSTREAM_SCOPE = "read:short";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Waits on the real clock until `epochMs`. */
const sleepUntil = (epochMs: number) => sleep(epochMs - Date.now());

/**
 * Expiry over time through a real FastMCP server, against the real tenant and the real clock, with
 * 30 second token lifetimes (the lifetime is read from the tenant configuration and asserted,
 * never assumed). No fake timers. Each scenario waits for a real token to expire.
 */
describeLive("fastmcp expiry over time", SHORT_VARS, (e2e) => {
  let shortDownstream: DownstreamApi;
  let servers: FastMcpServer[] = [];
  let sessions: Session[] = [];
  let counter: FetchCounter | undefined;

  beforeAll(async () => {
    shortDownstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.shortDownstreamAudience });
  });

  afterEach(async () => {
    counter?.restore();
    for (const session of sessions) await session.close();
    for (const server of servers) await server.stop();
    counter = undefined;
    sessions = [];
    servers = [];
    shortDownstream.calls.length = 0;
  });

  afterAll(async () => {
    await shortDownstream?.close();
  });

  /** Real caller token for the short MCP API, fresh because the clock is the point. */
  const shortCallerToken = () =>
    getUserToken(e2e, { audience: e2e.shortMcpAudience, scope: CALLER_SCOPE, fresh: true });

  it("E-X-01 a caller token that expires inside a stateful session is refused on the next call; a fresh token for the same user is served on the same session", async () => {
    const server = await startFastMcpServer({
      env: e2e,
      downstreamUrl: shortDownstream.url,
      stateless: false,
      audience: e2e.shortMcpAudience,
    });
    servers.push(server);
    const token = await shortCallerToken();
    const claims = decodeClaims(token);
    const exp = claims["exp"] as number;
    // The lifetime really is what the tenant was configured with, so the wait below is meaningful.
    expect(exp - (claims["iat"] as number)).toBe(e2e.shortLifetimeSeconds);

    const session = await connect(server, token);
    sessions.push(session);
    const id = session.sessionId!;
    const before = await callTool<WhoamiResult>(session, "whoami");
    expect(before.isError).toBe(false);
    expect(before.value.sessionSub).toBe(subjectOf(token));

    await sleepUntil(exp * 1000 + PAST_EXP_MARGIN_MS);

    // The old token on the same session id: every request is authenticated again, so it is refused.
    const expired = await callOnSession(server, id, token, "whoami");
    expect(expired.status).toBe(401);
    expect(expired.challenge?.scheme).toBe("Bearer");
    expect(expired.challenge?.params["error"]).toBe("invalid_token");
    expect(expired.toolText).toBeUndefined();

    // The session itself is not the problem: the same user with a fresh token continues on it.
    const fresh = await shortCallerToken();
    expect(subjectOf(fresh)).toBe(subjectOf(token));
    const resumed = await callOnSession(server, id, fresh, "whoami");
    expect(resumed.status).toBe(200);
    expect(JSON.parse(resumed.toolText!)).toMatchObject({ sessionSub: subjectOf(token) });
  });

  it("E-X-01 a caller token that expires is refused by a stateless server too", async () => {
    const server = await startFastMcpServer({
      env: e2e,
      downstreamUrl: shortDownstream.url,
      stateless: true,
      audience: e2e.shortMcpAudience,
    });
    servers.push(server);
    const token = await shortCallerToken();
    const exp = decodeClaims(token)["exp"] as number;

    const accepted = await postInitialize(server, `Bearer ${token}`);
    expect(accepted.status).toBe(200);

    await sleepUntil(exp * 1000 + PAST_EXP_MARGIN_MS);

    const refused = await postInitialize(server, `Bearer ${token}`);
    expect(refused.status).toBe(401);
    expect(refused.challenge?.params["error"]).toBe("invalid_token");

    // The rejection is about the old token, not the server.
    const fresh = await postInitialize(server, `Bearer ${await shortCallerToken()}`);
    expect(fresh.status).toBe(200);
  });

  it("E-X-02 a cached exchanged token past its exp is replaced by a new exchange for the same caller", async () => {
    // The normal MCP API and exchange client, but the downstream API is the short-lived one, so the
    // exchanged token lives 30 seconds while the caller token (24 hours) outlives it.
    const env: E2eEnv = { ...e2e, downstreamAudience: e2e.shortDownstreamAudience, downstreamScope: SHORT_DOWNSTREAM_SCOPE };
    counter = installFetchCounter();
    const server = await startFastMcpServer({
      env,
      downstreamUrl: shortDownstream.url,
      stateless: false,
      clientOptions: { tokenStore: new MemoryIndexedTokenStore() },
    });
    servers.push(server);
    const session = await connect(server, await firstUser(e2e).token({ fresh: true }));
    sessions.push(session);
    await callTool(session, "whoami");
    counter.reset();

    const delegate = async () => {
      const outcome = await callTool<DelegateResult>(session, "delegate");
      expect(outcome.isError).toBe(false);
      expect(outcome.value.status).toBe(200);
    };
    const lastExp = () => {
      const accepted = shortDownstream.calls.filter((call) => call.status === 200);
      return accepted[accepted.length - 1]!.claims!["exp"] as number;
    };

    await delegate();
    expect(counter.exchanges).toBe(1);
    const firstExp = lastExp();

    // Control: the same caller token is served from the store, so the exchange after the wait is
    // caused by expiry and by nothing else.
    await delegate();
    expect(counter.exchanges).toBe(1);

    await sleepUntil(firstExp * 1000 + PAST_EXP_MARGIN_MS);

    await delegate();
    expect(counter.exchanges).toBe(2);
    expect(lastExp()).toBeGreaterThan(firstExp);
  });
});
