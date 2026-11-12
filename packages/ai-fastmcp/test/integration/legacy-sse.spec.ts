import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRig, parseChallenge, rawRequest, socketFetch, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

/** `GET /sse`. The body is read only for a refusal, because an open event stream never ends. */
async function openSse(server: { url: URL }, headers: Record<string, string>) {
  const controller = new AbortController();
  try {
    const response = await socketFetch(new URL("/sse", server.url), {
      headers: { accept: "text/event-stream", ...headers },
      signal: controller.signal,
    });
    const body = response.status === 200 ? "" : await response.text();
    return { status: response.status, headers: response.headers, body };
  } finally {
    controller.abort();
  }
}

/**
 * FastMCP runs on mcp-proxy, whose default `GET /sse` route opens a legacy SSE session and takes
 * its messages on `POST /messages?sessionId=...`. FastMCP cannot turn the route off, and the
 * message route never calls `authenticate`. Before the adapter refused `GET /sse`, a caller who
 * knew the session id could post tool calls with no token, a wrong token or another user's token,
 * and they ran as the user who opened the stream.
 */
describe("legacy SSE route", () => {
  for (const stateless of [false, true]) {
    const mode = stateless ? "stateless" : "stateful";

    it(`refuses GET /sse with a valid token on a ${mode} server, so no session exists to post to`, async () => {
      await withServer({ stateless }, async (server) => {
        const reply = await openSse(server, { authorization: `Bearer ${await rig().token(server, { sub: "user|alice" })}` });
        expect(reply.status).toBe(404);
        expect(reply.headers.get("content-type")).not.toContain("text/event-stream");
        expect(reply.headers.get("www-authenticate")).toBeNull();
        expect(JSON.parse(reply.body)).toEqual({ error: "not_found", error_description: "Not found." });
        // Refused before any token work.
        expect(rig().requests).toEqual([]);
      });
    });

    it(`leaves a message posted to /messages nothing to reach on a ${mode} server`, async () => {
      await withServer({ stateless }, async (server) => {
        const opened = await openSse(server, { authorization: `Bearer ${await rig().token(server, { sub: "user|alice" })}` });
        expect(opened.status).toBe(404);
        for (const headers of [{} as Record<string, string>, { authorization: "Bearer nope" }]) {
          const response = await rawRequest(server, {
            path: "/messages?sessionId=00000000-0000-4000-8000-000000000000",
            headers,
            body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami_raw", arguments: {} } },
          });
          expect(response.status).toBe(400);
          await response.text();
        }
      });
    });
  }

  it("refuses GET /sse without a token the same way, without a challenge", async () => {
    await withServer({ stateless: false }, async (server) => {
      const reply = await openSse(server, {});
      expect(reply.status).toBe(404);
      expect(reply.headers.get("www-authenticate")).toBeNull();
    });
  });

  it("still serves the MCP route and its challenge", async () => {
    await withServer({ stateless: false }, async (server) => {
      const response = await rawRequest(server, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(response.status).toBe(401);
      expect(parseChallenge(response.headers.get("www-authenticate")).scheme).toBe("Bearer");
      await response.text();
    });
  });
});
