import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastMCP } from "fastmcp";
import { InvalidConfigurationError } from "@auth0/ai-mcp";
import { createFastMcpAuth } from "../../src/index.js";
import {
  DOMAIN,
  INITIALIZE_BODY,
  callTool,
  connect,
  createRig,
  freePort,
  parseMessage,
  rawRequest,
  socketFetch,
  withServer,
} from "../integration/harness.js";
import type { Session, TestServer } from "../integration/harness.js";
import { bearer, callerFor, fakeRequest, principalOf, stubClient, thrown } from "../support/stubs.js";
import { documented, loadSnippet } from "./guides.js";
import { withEnv } from "./server.js";

/** Pins every claim of docs/StatelessAndStateful.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const GUIDE = "StatelessAndStateful.md";

async function onSession(server: TestServer, sessionId: string, token: string, extra: Record<string, string> = {}) {
  const response = await rawRequest(server, {
    body: { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "whoami_raw", arguments: {} } },
    headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18", ...extra },
  });
  const body = await response.text();
  let text: string | undefined;
  try {
    text = (parseMessage(body) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text;
  } catch {
    text = undefined;
  }
  return { status: response.status, headers: response.headers, body, text };
}

function idOf(session: Session): string {
  const id = session.transport.sessionId;
  expect(id).toBeTypeOf("string");
  return id!;
}

describe("StatelessAndStateful.md: stateless mode", () => {
  it("issues no session id, serves every caller on its own token, and refuses GET and DELETE with 405 before authenticate", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const loaded = await withEnv(
      // A path other than FastMCP's default `/mcp`: the snippet serves it only because it passes auth.endpoint.
      { AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: `${origin}/orders`, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: undefined },
      () =>
        loadSnippet(GUIDE, 1, {
          rewrites: [["port: 3000", `host: "127.0.0.1", port: ${port}`]],
          exportNames: ["server"],
        }),
    );
    const server = loaded.exports["server"] as FastMCP<never>;
    const target = { url: new URL(`${origin}/orders`), audience: `${origin}/orders` };
    try {
      for (const sub of ["user|one", "user|two"]) {
        const response = await rawRequest(target, {
          body: INITIALIZE_BODY,
          headers: { authorization: `Bearer ${await rig().token(target, { sub })}` },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("mcp-session-id")).toBeNull();
      }
      // Without any token, so authenticate would answer 401 if it ran.
      expect((await socketFetch(target.url, { method: "GET" })).status).toBe(405);
      expect((await socketFetch(target.url, { method: "DELETE" })).status).toBe(405);
    } finally {
      await server.stop();
      loaded.dispose();
    }
    documented(
      GUIDE,
      "The session binding described below applies only to a request that carries a session id, and a stateless server issues none.",
      "FastMCP creates no session and issues no `mcp-session-id`",
      "FastMCP answers a `GET` or `DELETE` on the MCP route with 405 before `authenticate` runs.",
    );
  });
});

describe("StatelessAndStateful.md: stateful mode", () => {
  it("issues a session id on the first response and runs authenticate on GET and DELETE", async () => {
    await withServer({ stateless: false }, async (server) => {
      const first = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server)}` },
      });
      expect(first.status).toBe(200);
      expect(first.headers.get("mcp-session-id")).toBeTruthy();
      expect((await socketFetch(server.url, { method: "GET" })).status).toBe(401);
      expect((await socketFetch(server.url, { method: "DELETE" })).status).toBe(401);
      // On a live session, with a valid token of another subject: refused by the adapter, so authenticate ran.
      const id = first.headers.get("mcp-session-id")!;
      const mallory = `Bearer ${await rig().token(server, { sub: "user|mallory" })}`;
      await rawRequest(server, { body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: { authorization: `Bearer ${await rig().token(server)}`, "mcp-session-id": id } });
      for (const method of ["GET", "DELETE"]) {
        const response = await rawRequest(server, {
          method,
          headers: { authorization: mallory, "mcp-session-id": id, accept: "text/event-stream" },
        });
        expect(response.status).toBe(403);
      }
    });
    documented(
      GUIDE,
      "The first response carries an `mcp-session-id` header",
      "`authenticate` runs on every request, `GET` and `DELETE` included, so each request still needs a valid token.",
    );
  });

  it("lets a second caller ride on another caller's session id when the binding is off", async () => {
    await withServer({ stateless: false, auth: { sessionBinding: false } }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const reply = await onSession(server, idOf(alice), await rig().token(server, { sub: "user|bob" }));
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.text!)).toMatchObject({ sessionSub: "user|bob" });
      } finally {
        await alice.close();
      }
    });
    documented(
      GUIDE,
      "If a second caller presents a valid token together with the first caller's `mcp-session-id`, FastMCP accepts the request and runs the call as the second caller.",
      "`sessionBinding: false` turns it off",
    );
  });

  it("refuses the second subject with 403 and the documented body, with no challenge, and keeps serving the owner", async () => {
    await withServer({ stateless: false }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const id = idOf(alice);
        // The owner's own follow-up request binds the id.
        expect((await onSession(server, id, await rig().token(server, { sub: "user|alice" }))).status).toBe(200);
        const refused = await onSession(server, id, await rig().token(server, { sub: "user|bob" }));
        expect(refused.status).toBe(403);
        expect(refused.headers.get("www-authenticate")).toBeNull();
        expect(refused.body).toBe('{"error":"forbidden","error_description":"The session belongs to a different caller."}');
        const again = await onSession(server, id, await rig().token(server, { sub: "user|alice" }));
        expect(again.status).toBe(200);
        expect(JSON.parse(again.text!)).toMatchObject({ sessionSub: "user|alice" });
      } finally {
        await alice.close();
      }
    });
    documented(
      GUIDE,
      '{"error":"forbidden","error_description":"The session belongs to a different caller."}',
      "The response has no `WWW-Authenticate` header",
      "The owner of the session is not affected. It keeps calling with fresh tokens.",
    );
  });

  it("does not bind the initialize request, so two subjects can each open a session", async () => {
    await withServer({ stateless: false }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      const bob = await connect(server, await rig().token(server, { sub: "user|bob" }));
      try {
        expect(idOf(alice)).not.toBe(idOf(bob));
        expect((await callTool<{ sessionSub: string }>(bob, "whoami")).value.sessionSub).toBe("user|bob");
      } finally {
        await alice.close();
        await bob.close();
      }
    });
    documented(GUIDE, "The first request of a session, `initialize`, has none, so it cannot be bound.");
  });

  it("binds the id to whoever sends the first request that carries it", async () => {
    await withServer({ stateless: false }, async (server) => {
      const created = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server, { sub: "user|alice" })}` },
      });
      const id = created.headers.get("mcp-session-id")!;
      // Another subject learns the id and uses it before the owner's follow-up.
      expect((await onSession(server, id, await rig().token(server, { sub: "user|bob" }))).status).toBe(200);
      expect((await onSession(server, id, await rig().token(server, { sub: "user|alice" }))).status).toBe(403);
    });
    documented(
      GUIDE,
      "**The first request with an id wins.**",
      "A caller who learns another caller's id before that caller's first follow-up owns the id, and the real owner is then refused.",
    );
  });

  it("answers a session id longer than 256 characters with 400 and no challenge, and lets 256 through", async () => {
    await withServer({ stateless: false }, async (server) => {
      const token = await rig().token(server);
      const long = await onSession(server, "a".repeat(257), token);
      expect(long.status).toBe(400);
      expect(long.headers.get("www-authenticate")).toBeNull();
      expect(long.body).toBe('{"error":"invalid_request","error_description":"The session id is not valid."}');
      const edge = await onSession(server, "a".repeat(256), token);
      expect(edge.status).not.toBe(400);
      expect(edge.status).not.toBe(403);
    });
    documented(
      GUIDE,
      "The adapter answers a session id longer than 256 characters with 400 `invalid_request` and the description `The session id is not valid.`.",
    );
  });
});

describe("StatelessAndStateful.md: the limits of the binding", () => {
  const HOUR = 3_600_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  function adapter(extra: Record<string, unknown> = {}) {
    const client = stubClient({
      verify: async (verifyOptions) => callerFor(principalOf({ sub: (verifyOptions as { accessToken: string }).accessToken })),
    });
    return createFastMcpAuth({ client, ...extra } as never);
  }

  const as = (subject: string, sessionId: string) =>
    fakeRequest({ ...bearer(subject), "mcp-session-id": sessionId });

  it("forgets an id one hour after its last use, and each use renews the hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const auth = adapter();
    await auth.authenticate(as("alice", "s1"));
    vi.advanceTimersByTime(HOUR - 1);
    await auth.authenticate(as("alice", "s1")); // renews
    vi.advanceTimersByTime(HOUR - 1);
    expect(((await thrown(auth.authenticate(as("bob", "s1")))) as Response).status).toBe(403);
    vi.advanceTimersByTime(HOUR + 1);
    // More than an hour after the last use of alice: bob owns the id now.
    expect((await auth.authenticate(as("bob", "s1"))).principal.sub).toBe("bob");
    documented(GUIDE, "3600000 milliseconds (one hour) after the last use. Each use renews the time");
  });

  it("remembers 10000 session ids by default and forgets the oldest beyond that", async () => {
    // 101 subjects, so no subject reaches its own limit of 100 and only the size of the table matters.
    const owner = (i: number) => `u${i % 101}`;
    const auth = adapter();
    for (let i = 0; i < 10_000; i++) await auth.authenticate(as(owner(i), `s${i}`));
    expect(((await thrown(auth.authenticate(as("bob", "s0")))) as Response).status).toBe(403);

    const over = adapter();
    for (let i = 0; i < 10_001; i++) await over.authenticate(as(owner(i), `s${i}`));
    expect((await over.authenticate(as("bob", "s0"))).principal.sub).toBe("bob");
    expect(((await thrown(over.authenticate(as("bob", "s10000")))) as Response).status).toBe(403);
    documented(GUIDE, "The defaults are 10000 session ids, 100 per subject,");
    documented("README.md", "10000 ids, 100 per subject and one hour of idle time by default");
  });

  it("lets a subject hold 100 ids by default and replaces that subject's own oldest id beyond that", async () => {
    const auth = adapter();
    for (let i = 0; i < 101; i++) await auth.authenticate(as("alice", `a${i}`));
    await auth.authenticate(as("carol", "c0"));
    // a0 was alice's oldest id and is forgotten; carol's id and alice's newer ids stay bound.
    expect((await auth.authenticate(as("bob", "a0"))).principal.sub).toBe("bob");
    expect(((await thrown(auth.authenticate(as("bob", "a1")))) as Response).status).toBe(403);
    expect(((await thrown(auth.authenticate(as("bob", "c0")))) as Response).status).toBe(403);
    documented(
      GUIDE,
      "A subject that reaches its limit replaces its own oldest id, and when the whole table is full the adapter forgets the least recently used id first.",
      "A value of `maxSessionsPerSubject` above `maxSessions` has no effect, because the whole table never holds more.",
    );
    expect(() => adapter({ sessionBinding: { maxSessionsPerSubject: 0 } })).toThrow(
      '"sessionBinding.maxSessionsPerSubject" must be a positive number.',
    );
  });

  it("ignores a per-subject limit above maxSessions", async () => {
    const auth = adapter({ sessionBinding: { maxSessions: 3, maxSessionsPerSubject: 50 } });
    for (let i = 0; i < 10; i++) await auth.authenticate(as("alice", `a${i}`));
    expect((await auth.authenticate(as("bob", "a6"))).principal.sub).toBe("bob");
    expect(((await thrown(auth.authenticate(as("bob", "a9")))) as Response).status).toBe(403);
  });

  it("keeps another subject's binding when a caller sends many ids FastMCP never issued", async () => {
    await withServer(
      { stateless: false, auth: { sessionBinding: { maxSessions: 4, maxSessionsPerSubject: 2 } } },
      async (server) => {
        const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
        try {
          const bob = await rig().token(server, { sub: "user|bob" });
          for (let i = 0; i < 12; i++) {
            const response = await rawRequest(server, {
              body: { jsonrpc: "2.0", id: i, method: "tools/list" },
              headers: { authorization: `Bearer ${bob}`, "mcp-session-id": randomUUID(), "mcp-protocol-version": "2025-06-18" },
            });
            // FastMCP refuses the unknown id (404, or 401 on older mcp-proxy releases); the adapter has recorded it.
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.status).not.toBe(403);
          }
          const reply = await onSession(server, idOf(alice), bob);
          expect(reply.status).toBe(403);
        } finally {
          await alice.close();
        }
      },
    );
    documented(
      GUIDE,
      "**Ids FastMCP never issued are recorded too.**",
      "It raises the cost of the attack and does not end it. Several accounts together can still fill the table",
      "Stateless mode is the fix.",
    );
  });

  it("binds a session id that a gateway forwards to a stateless server", async () => {
    await withServer({ stateless: true }, async (server) => {
      const headers = (token: string) => ({ authorization: `Bearer ${token}`, "mcp-session-id": "fixed-by-the-gateway" });
      const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
      const first = await rawRequest(server, { body: list, headers: headers(await rig().token(server, { sub: "user|one" })) });
      const second = await rawRequest(server, { body: list, headers: headers(await rig().token(server, { sub: "user|two" })) });
      expect(first.status).toBe(200);
      expect(second.status).toBe(403);
    });
    documented(
      GUIDE,
      "It cannot tell which mode FastMCP runs in, so it binds a session id on any server that receives one.",
      "a second user behind the same id gets 403.",
    );
  });

  it("leaves a live session without a binding when a stream stays open longer than ttlMs", async () => {
    await withServer({ stateless: false, auth: { sessionBinding: { ttlMs: 50 } } }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      const stream = new AbortController();
      try {
        const aliceToken = await rig().token(server, { sub: "user|alice" });
        const open = await socketFetch(server.url, {
          method: "GET",
          headers: { authorization: `Bearer ${aliceToken}`, "mcp-session-id": idOf(alice), accept: "text/event-stream" },
          signal: stream.signal,
        });
        // 200 for a stream that opened; 409 when the client already holds the standalone stream.
        expect([200, 409]).toContain(open.status);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const reply = await onSession(server, idOf(alice), await rig().token(server, { sub: "user|bob" }));
        expect(reply.status).toBe(200);
        expect(reply.text).toContain("user|bob");
      } finally {
        stream.abort();
        await alice.close();
      }
    });
    documented(
      GUIDE,
      "**An idle stream outlives its binding.**",
      "Set `ttlMs` above the longest stream you expect.",
    );
  });

  it("evicts the least recently used id first when the table is full", async () => {
    const auth = adapter({ sessionBinding: { maxSessions: 2 } });
    await auth.authenticate(as("alice", "s1"));
    await auth.authenticate(as("alice", "s2"));
    await auth.authenticate(as("alice", "s1")); // s1 is the most recently used
    await auth.authenticate(as("alice", "s3")); // evicts s2
    expect(((await thrown(auth.authenticate(as("bob", "s1")))) as Response).status).toBe(403);
    expect((await auth.authenticate(as("bob", "s2"))).principal.sub).toBe("bob");
    documented(GUIDE, "when the whole table is full the adapter forgets the least recently used id first");
  });

  it("does not share the table between two adapters, which stand for two processes", async () => {
    const one = adapter();
    const two = adapter();
    await one.authenticate(as("alice", "s1"));
    expect((await two.authenticate(as("bob", "s1"))).principal.sub).toBe("bob");
    documented(GUIDE, "**One process.** The table lives in the memory of the process. Instances do not share it, and a restart empties it.");
  });

  it("needs positive numbers for both limits", () => {
    const client = stubClient();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number]) {
      expect(() => createFastMcpAuth({ client, sessionBinding: { maxSessions: bad } })).toThrow(
        '"sessionBinding.maxSessions" must be a positive number.',
      );
      expect(() => createFastMcpAuth({ client, sessionBinding: { ttlMs: bad } })).toThrow(
        '"sessionBinding.ttlMs" must be a positive number.',
      );
      expect(() => createFastMcpAuth({ client, sessionBinding: { ttlMs: bad } })).toThrow(InvalidConfigurationError);
    }
    expect(() => createFastMcpAuth({ client, sessionBinding: { maxSessions: 1000, ttlMs: 15 * 60 * 1000 } })).not.toThrow();
    documented(GUIDE, "The values must be positive numbers, or `createFastMcpAuth` throws `InvalidConfigurationError`.");
  });

  it("builds the adapter of the guide's limits block", async () => {
    const loaded = await withEnv({ AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: "https://mcp.example.com/mcp" }, () =>
      loadSnippet(GUIDE, 2, { exportNames: ["auth"] }),
    );
    try {
      expect((loaded.exports["auth"] as { oauth: { enabled: boolean } }).oauth.enabled).toBe(true);
    } finally {
      loaded.dispose();
    }
  });
});
