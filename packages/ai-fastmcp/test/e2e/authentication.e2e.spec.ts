/**
 * Authentication through a real FastMCP server, against the real tenant: tokens the tenant issued
 * reach a tool with the caller in the session, and every other bearer value is refused with a 401
 * and a challenge that points at the metadata document. Both FastMCP modes run each scenario.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LIBRARY_TEXT,
  callTool,
  connect,
  decodeClaims,
  describeLive,
  expectNoTokens,
  firstUser,
  getUserToken,
  headerOnly,
  headersText,
  limitedClient,
  postInitialize,
  signedByAttacker,
  startDownstreamApi,
  startFastMcpServer,
  subjectOf,
  withAlgNone,
  withForeignSignature,
  withTamperedPayload,
} from "./support/index.js";
import type { DownstreamApi, FastMcpServer, WhoamiResult } from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

const INVALID_TOKEN_BODY = {
  error: "invalid_token",
  error_description: "The access token is invalid or has expired.",
};

describeLive("fastmcp authentication", [], (e2e) => {
  const user = firstUser(e2e);
  const hasLimited = e2e.limitedClientId !== "";
  let downstream: DownstreamApi;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
  });

  afterAll(async () => {
    await downstream?.close();
  });

  describe.each(MODES)("$label server", ({ stateless }) => {
    let server: FastMcpServer;
    let userToken: string;

    beforeAll(async () => {
      userToken = await user.token();
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("E-A-01 a valid user token reaches a tool and the session holds the caller", async () => {
      const session = await connect(server, userToken);
      try {
        const { isError, value } = await callTool<WhoamiResult>(session, "whoami");
        expect(isError).toBe(false);
        expect(value.sessionSub).toBe(subjectOf(userToken));
        expect(value.accessorSub).toBe(value.sessionSub);
        expect(value.clientSub).toBe(value.sessionSub);
        expect(value.clientId).toBe(e2e.loginClientId);
        expect(value.orgId).toBeNull();
        expect(value.scopes).toEqual(expect.arrayContaining([...user.scopes]));
      } finally {
        await session.close();
      }
    });

    it.skipIf(!hasLimited)("E-A-01 a client credentials token reaches the same tool with its own subject", async () => {
      const machine = limitedClient(e2e);
      const token = await machine.token();
      const session = await connect(server, token);
      try {
        const { isError, value } = await callTool<WhoamiResult>(session, "whoami");
        expect(isError).toBe(false);
        expect(value.sessionSub).toBe(subjectOf(token));
        expect(value.sessionSub).toMatch(/@clients$/);
        expect(value.clientId).toBe(machine.clientId);
        expect(value.scopes).toEqual(["tool:whoami"]);
      } finally {
        await session.close();
      }
    });

    describe("a request without a usable credential", () => {
      it("E-A-02 no Authorization header: 401, a bare Bearer challenge that names the metadata, no error code", async () => {
        const res = await postInitialize(server);
        expect(res.status).toBe(401);
        expect(res.challenge?.scheme).toBe("Bearer");
        expect(res.challenge?.params["resource_metadata"]).toMatch(/\/\.well-known\/oauth-protected-resource\/mcp$/);
        expect(res.challenge?.params).not.toHaveProperty("error");
        expect(JSON.parse(res.body)).toEqual({ error: "unauthorized", error_description: "Authentication is required." });
      });

      it("E-A-02 a real client sees the 401 and the challenge", async () => {
        const failure = await connect(server).then(
          () => undefined,
          (error: Error & { seen: Array<{ status: number; wwwAuthenticate: string | null }> }) => error,
        );
        expect(failure).toBeDefined();
        expect(failure!.seen[0]!.status).toBe(401);
        expect(failure!.seen[0]!.wwwAuthenticate).toMatch(/^Bearer /);
      });
    });

    describe("hostile bearer values", () => {
      let real: string;
      const sent: string[] = [];

      beforeAll(async () => {
        real = userToken;
      });

      const cases: Array<[string, () => Promise<string> | string]> = [
        ["not a JWT", () => "not.a.token"],
        ["three segments that are not a JWT", () => "aaaa.bbbb.cccc"],
        ["the header of a real token alone", () => headerOnly(real)],
        ["a real token with one payload character changed", () => withTamperedPayload(real)],
        ["a real header and payload with another signature", () => withForeignSignature(real)],
        ["a real token with alg none", () => withAlgNone(real)],
        ["signed with a key the tenant does not publish, under the real kid", () => signedByAttacker(real)],
        [
          "signed with a key the tenant does not publish, claiming another issuer",
          () => signedByAttacker(real, { issuer: "https://issuer.example.invalid/" }),
        ],
      ];

      it.each(cases)("E-A-02 %s: 401 invalid_token, no library text, no echo", async (_name, build) => {
        const token = await build();
        sent.push(token);
        const res = await postInitialize(server, `Bearer ${token}`);
        expect(res.status).toBe(401);
        expect(res.challenge?.scheme).toBe("Bearer");
        expect(res.challenge?.params["error"]).toBe("invalid_token");
        expect(res.challenge?.params["resource_metadata"]).toMatch(/\/\.well-known\/oauth-protected-resource\/mcp$/);
        expect(JSON.parse(res.body)).toEqual(INVALID_TOKEN_BODY);
        const headers = headersText(res.headers);
        expect(headers).not.toMatch(LIBRARY_TEXT);
        expect(res.body).not.toMatch(LIBRARY_TEXT);
        expectNoTokens("the response", `${headers}\n${res.body}`, [token]);
      });

      it.each([
        ["an empty bearer value", "Bearer "],
        ["a bearer value of two words", "Bearer a b"],
      ])("E-A-02 %s is a malformed request: 400 invalid_request with a Bearer challenge", async (_name, authorization) => {
        const res = await postInitialize(server, authorization);
        expect(res.status).toBe(400);
        expect(res.challenge?.scheme).toBe("Bearer");
        expect(res.challenge?.params["error"]).toBe("invalid_request");
        expect(res.challenge?.params["resource_metadata"]).toMatch(/\/\.well-known\/oauth-protected-resource\/mcp$/);
      });

      it("E-A-02 another scheme counts as no credential: 401 and a bare Bearer challenge", async () => {
        const res = await postInitialize(server, "Basic dXNlcjpwYXNz");
        expect(res.status).toBe(401);
        expect(res.challenge?.scheme).toBe("Bearer");
        expect(res.challenge?.params).not.toHaveProperty("error");
      });

      it("E-A-02 a 20 KB bearer value is refused before the adapter, and is neither served nor a server error", async () => {
        const res = await postInitialize(server, `Bearer ${"a".repeat(20_000)}`).catch(() => undefined);
        // Node refuses oversized headers with 431 or closes the socket; both are fine, 200 and 500 are not.
        if (res !== undefined) {
          expect(res.status).not.toBe(200);
          expect(res.status).toBeLessThan(500);
        }
      });

      it("E-A-02 the server is still healthy and logged no token", async () => {
        const session = await connect(server, userToken);
        try {
          expect((await callTool(session, "whoami")).isError).toBe(false);
        } finally {
          await session.close();
        }
        expectNoTokens("the server log", server.logs.join("\n"), [userToken, ...sent]);
      });
    });

    describe("tenant tokens that are not for this server", () => {
      it("E-A-01 a tenant-signed token for another audience: 401 invalid_token", async () => {
        const otherAudience = await getUserToken(e2e, { audience: e2e.downstreamAudience, scope: e2e.downstreamScope });
        expect(decodeClaims(otherAudience)["aud"]).not.toEqual(e2e.mcpAudience);
        const res = await postInitialize(server, `Bearer ${otherAudience}`);
        expect(res.status).toBe(401);
        expect(res.challenge?.params["error"]).toBe("invalid_token");
        expect(JSON.parse(res.body)).toEqual(INVALID_TOKEN_BODY);
        expectNoTokens("the response", res.body, [otherAudience]);
      });
    });
  });
});
