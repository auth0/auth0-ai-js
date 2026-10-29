/**
 * Pins the FastMCP behavior the adapter and its documentation rely on, so that a FastMCP release
 * that changes it fails here and not in a customer's server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { INITIALIZE_BODY, callTool, connect, createRig, parseChallenge, parseMessage, rawRequest, socketFetch, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

describe("routes that never reach authenticate", () => {
  it("answers /health and /ready without a token, on both modes", async () => {
    for (const stateless of [true, false]) {
      await withServer({ stateless }, async (server) => {
        const health = await socketFetch(`${server.origin}/health`);
        expect(health.status).toBe(200);
        // /ready reports the sessions: 503 until a stateful server has one. Never a challenge.
        const ready = await socketFetch(`${server.origin}/ready`);
        expect([200, 503]).toContain(ready.status);
        expect(ready.headers.get("www-authenticate")).toBeNull();
      });
    }
  });

  it("answers an unknown path with 404", async () => {
    await withServer({ stateless: true }, async (server) => {
      expect((await socketFetch(`${server.origin}/nothing-here`)).status).toBe(404);
    });
  });

  it("answers GET and DELETE on a stateless MCP route with 405, before any authentication", async () => {
    await withServer({ stateless: true }, async (server) => {
      for (const method of ["GET", "DELETE"]) {
        const response = await rawRequest(server, { method });
        expect(response.status).toBe(405);
        expect(response.headers.get("www-authenticate")).toBeNull();
      }
      expect(rig().requests).toEqual([]);
    });
  });

  it("runs authenticate for GET and DELETE on a stateful MCP route", async () => {
    await withServer({ stateless: false }, async (server) => {
      for (const method of ["GET", "DELETE"]) {
        const response = await rawRequest(server, { method, headers: { accept: "text/event-stream" } });
        expect(response.status).toBe(401);
        expect(parseChallenge(response.headers.get("www-authenticate")).scheme).toBe("Bearer");
      }
    });
  });
});

describe("protocol revision", () => {
  it("does not speak the 2026-07-28 revision: FastMCP negotiates it down", async () => {
    await withServer({ stateless: true }, async (server) => {
      const token = await rig().token(server);
      const response = await rawRequest(server, {
        body: { ...INITIALIZE_BODY, params: { ...INITIALIZE_BODY.params, protocolVersion: "2026-07-28" } },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const message = parseMessage(await response.text()) as { result: { protocolVersion: string } };
      expect(message.result.protocolVersion).toBeTypeOf("string");
      expect(message.result.protocolVersion).not.toBe("2026-07-28");
    });
  });

  it("serves the revisions the documentation names", async () => {
    await withServer({ stateless: true }, async (server) => {
      const token = await rig().token(server);
      for (const protocolVersion of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
        const response = await rawRequest(server, {
          body: { ...INITIALIZE_BODY, params: { ...INITIALIZE_BODY.params, protocolVersion } },
          headers: { authorization: `Bearer ${token}` },
        });
        const message = parseMessage(await response.text()) as { result: { protocolVersion: string } };
        expect(message.result.protocolVersion).toBe(protocolVersion);
      }
    });
  });
});

describe("a failing tenant", () => {
  it("never leaks the failure, and the server recovers when the tenant does", async () => {
    await withServer({ stateless: true }, async (server) => {
      rig().use(
        http.get(`https://tenant.example.com/.well-known/openid-configuration`, () =>
          HttpResponse.text("internal-secret-stack-trace at line 42", { status: 500 }),
        ),
      );
      const token = await rig().token(server);
      const failed = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
      // The core reports a discovery failure as a token verification failure today (401).
      // A change to 503 or 500 is acceptable; leaking the upstream text is not.
      expect([401, 500, 503]).toContain(failed.status);
      const text = await failed.text();
      expect(text).not.toContain("internal-secret");
      expect(failed.headers.get("www-authenticate") ?? "").not.toContain("internal-secret");
      expect(server.errors.map((e) => String(e))).not.toContain("internal-secret");

      rig().use(
        http.get(`https://tenant.example.com/.well-known/openid-configuration`, () =>
          HttpResponse.json({
            issuer: rig().tenant.auth0.issuer,
            jwks_uri: rig().tenant.auth0.jwksUri,
            token_endpoint: rig().tenant.auth0.tokenEndpoint,
            id_token_signing_alg_values_supported: [rig().tenant.key.alg],
          }),
        ),
      );
      const session = await connect(server, token);
      await session.close();
    });
  });

  it("keeps the failure of the token endpoint out of the response of authenticate", async () => {
    await withServer({ stateless: true }, async (server) => {
      rig().tenant.auth0.state.failure = { status: 500, body: { error: "internal-secret" } };
      const session = await connect(server, await rig().token(server));
      try {
        expect((await callTool(session, "whoami")).isError).toBe(false);
        const outcome = await callTool(session, "delegate");
        expect(outcome.isError).toBe(true);
        expect(JSON.stringify(outcome)).not.toContain("internal-secret");
      } finally {
        await session.close();
      }
    });
  });
});
