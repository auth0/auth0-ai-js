/**
 * Session ids through a real stateful FastMCP server, against the real tenant, with two real users.
 * FastMCP accepts any valid token on any session id, so the adapter binds each id to the subject
 * that used it first. The scenarios open a session as the first user and then present the second
 * user's real token on that id.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  SECOND_USER_VARS,
  callOnSession,
  callTool,
  connect,
  describeLive,
  expectNoTokens,
  firstUser,
  rawRequest,
  secondUser,
  startDownstreamApi,
  startFastMcpServer,
  subjectOf,
} from "./support/index.js";
import type { DownstreamApi, FastMcpServer, Session, WhoamiResult } from "./support/index.js";

describeLive("fastmcp session binding", SECOND_USER_VARS, (e2e) => {
  let downstream: DownstreamApi;
  let firstToken: string;
  let secondToken: string;
  let firstSub: string;
  let secondSub: string;
  let server: FastMcpServer | undefined;
  let owner: Session | undefined;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    firstToken = await firstUser(e2e).token();
    secondToken = await secondUser(e2e).token();
    firstSub = subjectOf(firstToken);
    secondSub = subjectOf(secondToken);
  });

  afterEach(async () => {
    await owner?.close();
    await server?.stop();
    owner = undefined;
    server = undefined;
  });

  afterAll(async () => {
    await downstream?.close();
  });

  /** Opens a session as the first user on a fresh stateful server. */
  async function openSession(auth: { sessionBinding?: false } = {}): Promise<{ server: FastMcpServer; owner: Session; id: string }> {
    server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless: false, auth });
    owner = await connect(server, firstToken);
    const id = owner.sessionId;
    expect(id, "the stateful server issued a session id").toBeTypeOf("string");
    return { server, owner, id: id! };
  }

  it("FM-05 the second user's real token on the first user's session id is refused with 403, no challenge, and the tool does not run", async () => {
    const { server: running, owner: active, id } = await openSession();
    const reply = await callOnSession(running, id, secondToken, "whoami");
    expect(reply.status).toBe(403);
    expect(reply.headers.get("www-authenticate")).toBeNull();
    expect(JSON.parse(reply.body)).toEqual({
      error: "forbidden",
      error_description: "The session belongs to a different caller.",
    });
    expect(reply.toolText).toBeUndefined();
    expect(reply.body).not.toContain(firstSub);
    expectNoTokens("the response", reply.body, [firstToken, secondToken]);
    // The owner is not affected.
    const mine = await callTool<WhoamiResult>(active, "whoami");
    expect(mine.value.sessionSub).toBe(firstSub);
  });

  it("FM-05 the owner can keep using the session id with a fresh token", async () => {
    const { server: running, id } = await openSession();
    const fresh = await firstUser(e2e).token({ fresh: true });
    const reply = await callOnSession(running, id, fresh, "whoami");
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.toolText!)).toMatchObject({ sessionSub: firstSub });
  });

  it("FM-05 a GET or DELETE with the other user's token is refused too, and the session survives", async () => {
    const { server: running, owner: active, id } = await openSession();
    for (const method of ["GET", "DELETE"]) {
      const response = await rawRequest(running, {
        method,
        headers: { authorization: `Bearer ${secondToken}`, "mcp-session-id": id },
      });
      await response.arrayBuffer();
      expect(response.status, method).toBe(403);
    }
    expect((await callTool(active, "whoami")).isError).toBe(false);
  });

  it("FM-05 a bad token on a bound session id is a 401 with a challenge, not a 403", async () => {
    const { server: running, id } = await openSession();
    const reply = await callOnSession(running, id, "not.a.token", "whoami");
    expect(reply.status).toBe(401);
    expect(reply.challenge?.params["error"]).toBe("invalid_token");
  });

  it("FM-05 two users each get a session of their own and each is served as itself", async () => {
    const { server: running, owner: first, id } = await openSession();
    const second = await connect(running, secondToken);
    try {
      expect(second.sessionId).toBeTypeOf("string");
      expect(second.sessionId).not.toBe(id);
      expect((await callTool<WhoamiResult>(first, "whoami")).value.sessionSub).toBe(firstSub);
      expect((await callTool<WhoamiResult>(second, "whoami")).value.sessionSub).toBe(secondSub);
    } finally {
      await second.close();
    }
  });

  it("FM-05 pinned-behavior: with the binding off FastMCP runs the call as the second user, never as the first", async () => {
    const { server: running, id } = await openSession({ sessionBinding: false });
    const reply = await callOnSession(running, id, secondToken, "whoami");
    expect(reply.status).toBe(200);
    const seen = JSON.parse(reply.toolText!) as WhoamiResult;
    expect(seen.sessionSub).toBe(secondSub);
    expect(seen.accessorSub).toBe(secondSub);
    expect(seen.sessionSub).not.toBe(firstSub);
  });
});
