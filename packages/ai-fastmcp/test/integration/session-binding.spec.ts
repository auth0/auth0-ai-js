import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callTool, connect, createRig, parseMessage, rawRequest, withServer } from "./harness.js";
import type { Session, TestServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

interface Reply {
  status: number;
  headers: Headers;
  body: string;
  /** The `text` of the first content item of a JSON-RPC tool result, when there is one. */
  toolText: string | undefined;
}

/** One raw `tools/call` on an existing session id, with the given token. */
async function callOnSession(
  server: TestServer,
  sessionId: string,
  token: string,
  name = "whoami_raw",
): Promise<Reply> {
  const response = await rawRequest(server, {
    body: { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: {} } },
    headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
  });
  const body = await response.text();
  let toolText: string | undefined;
  try {
    toolText = (parseMessage(body) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text;
  } catch {
    toolText = undefined;
  }
  return { status: response.status, headers: response.headers, body, toolText };
}

function sessionIdOf(session: Session): string {
  const id = session.transport.sessionId;
  expect(id).toBeTypeOf("string");
  return id!;
}

describe("session binding on a stateful server", () => {
  it("refuses a second subject on another caller's session id", async () => {
    await withServer({ stateless: false }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const id = sessionIdOf(alice);
        const bobToken = await rig().token(server, { sub: "user|bob" });
        const reply = await callOnSession(server, id, bobToken);
        expect(reply.status).toBe(403);
        expect(reply.headers.get("www-authenticate")).toBeNull();
        expect(JSON.parse(reply.body)).toEqual({
          error: "forbidden",
          error_description: "The session belongs to a different caller.",
        });
        expect(reply.body).not.toContain("alice");
        // Alice is not affected.
        const outcome = await callTool<{ sessionSub: string }>(alice, "whoami");
        expect(outcome.value.sessionSub).toBe("user|alice");
      } finally {
        await alice.close();
      }
    });
  });

  it("still lets the owner call on the session id with a fresh token", async () => {
    await withServer({ stateless: false }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const reply = await callOnSession(server, sessionIdOf(alice), await rig().token(server, { sub: "user|alice" }));
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.toolText!)).toMatchObject({ sessionSub: "user|alice" });
      } finally {
        await alice.close();
      }
    });
  });

  it("refuses the other subject on a GET and on a DELETE for the session as well", async () => {
    await withServer({ stateless: false }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const id = sessionIdOf(alice);
        const bob = `Bearer ${await rig().token(server, { sub: "user|bob" })}`;
        for (const method of ["GET", "DELETE"]) {
          const response = await rawRequest(server, {
            method,
            headers: { authorization: bob, "mcp-session-id": id, accept: "text/event-stream" },
          });
          expect(response.status).toBe(403);
        }
        // The session is still alive for alice.
        expect((await callTool(alice, "whoami")).isError).toBe(false);
      } finally {
        await alice.close();
      }
    });
  });

  it("does not stop a second subject from opening a session of their own", async () => {
    await withServer({ stateless: false }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      const bob = await connect(server, await rig().token(server, { sub: "user|bob" }));
      try {
        expect(sessionIdOf(alice)).not.toBe(sessionIdOf(bob));
        expect((await callTool<{ sessionSub: string }>(bob, "whoami")).value.sessionSub).toBe("user|bob");
        expect((await callTool<{ sessionSub: string }>(alice, "whoami")).value.sessionSub).toBe("user|alice");
      } finally {
        await alice.close();
        await bob.close();
      }
    });
  });

  it("checks the token before the binding: a bad token on a bound session is a 401, not a 403", async () => {
    await withServer({ stateless: false }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const reply = await callOnSession(server, sessionIdOf(alice), "not-a-jwt");
        expect(reply.status).toBe(401);
      } finally {
        await alice.close();
      }
    });
  });

  it("refuses an oversized session id before anything else", async () => {
    await withServer({ stateless: false }, async (server) => {
      const reply = await callOnSession(server, "x".repeat(300), await rig().token(server));
      expect(reply.status).toBe(400);
      expect(rig().requests).toEqual([]);
    });
  });
});

describe("session binding switched off", () => {
  it("lets FastMCP run the call as the second subject, which is the gap the binding closes", async () => {
    await withServer({ stateless: false, auth: { sessionBinding: false } }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const reply = await callOnSession(server, sessionIdOf(alice), await rig().token(server, { sub: "user|bob" }));
        expect(reply.status).toBe(200);
        expect(JSON.parse(reply.toolText!)).toMatchObject({ sessionSub: "user|bob" });
      } finally {
        await alice.close();
      }
    });
  });
});

describe("session binding limits", () => {
  it("forgets a session id after the ttl, so the binding is per process and bounded in time", async () => {
    await withServer({ stateless: false, auth: { sessionBinding: { ttlMs: 50 } } }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const id = sessionIdOf(alice);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const reply = await callOnSession(server, id, await rig().token(server, { sub: "user|bob" }));
        expect(reply.status).toBe(200);
      } finally {
        await alice.close();
      }
    });
  });

  it("does not apply to a stateless server, which has no session ids", async () => {
    await withServer({ stateless: true }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        expect(alice.transport.sessionId).toBeUndefined();
        const bob = await connect(server, await rig().token(server, { sub: "user|bob" }));
        try {
          expect((await callTool<{ sessionSub: string }>(bob, "whoami")).value.sessionSub).toBe("user|bob");
        } finally {
          await bob.close();
        }
      } finally {
        await alice.close();
      }
    });
  });
});
