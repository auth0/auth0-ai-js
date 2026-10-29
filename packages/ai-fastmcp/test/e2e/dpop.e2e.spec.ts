/**
 * DPoP through a real FastMCP server, against the real tenant. The adapter verifies Bearer tokens
 * only, so a request that carries a DPoP header, the DPoP scheme, or a key-bound token is refused
 * with a Bearer challenge, before any call to the tenant.
 *
 * Whether the tenant can issue a DPoP-bound token is checked at run time: it is asked for one with
 * a real proof, and the bound-token scenario is skipped, with the reason, when it answers with an
 * ordinary Bearer token. Nothing is written to the tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDpopProof,
  connect,
  describeLive,
  expectNoTokens,
  firstUser,
  generateDpopKeyPair,
  headersText,
  installFetchCounter,
  postInitialize,
  requestDpopBoundUserToken,
  startDownstreamApi,
  startFastMcpServer,
} from "./support/index.js";
import type { DownstreamApi, DpopKeyPair, FetchCounter, FastMcpServer } from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

describeLive("fastmcp DPoP", [], (e2e) => {
  const user = firstUser(e2e);
  let downstream: DownstreamApi;
  let userToken: string;
  let keys: DpopKeyPair;
  let counter: FetchCounter | undefined;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await user.token();
    keys = await generateDpopKeyPair();
  });

  afterAll(async () => {
    await downstream?.close();
  });

  const tenantRequests = () => (counter?.requests ?? []).filter((line) => line.includes(e2e.domain));

  describe.each(MODES)("$label server", ({ stateless }) => {
    let server: FastMcpServer;

    beforeAll(async () => {
      // The counter goes in before the server verifies anything, so discovery and key fetches would show.
      counter = installFetchCounter();
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless });
    });

    afterAll(async () => {
      await server?.stop();
      counter?.restore();
      counter = undefined;
    });

    it("FM-06 a valid Bearer token with a DPoP header is refused with a Bearer challenge, before any tenant traffic", async () => {
      const proof = await buildDpopProof(keys, { htm: "POST", htu: server.audience, accessToken: userToken });
      const res = await postInitialize(server, `Bearer ${userToken}`, { dpop: proof });
      expect(res.status).toBe(401);
      expect(res.challenge?.scheme).toBe("Bearer");
      expect(res.challenge?.params["error"]).toBe("invalid_token");
      expect(JSON.parse(res.body)).toEqual({
        error: "invalid_token",
        error_description: "DPoP is not supported by this server.",
      });
      expect(res.challenge?.params).not.toHaveProperty("algs");
      expectNoTokens("the response", `${headersText(res.headers)}\n${res.body}`, [userToken, proof]);
      expect(tenantRequests()).toEqual([]);
    });

    it("FM-06 a DPoP header without any Authorization header is refused the same way", async () => {
      const proof = await buildDpopProof(keys, { htm: "POST", htu: server.audience });
      const res = await postInitialize(server, undefined, { dpop: proof });
      expect(res.status).toBe(401);
      expect(res.challenge?.scheme).toBe("Bearer");
      expect(res.challenge?.params["error"]).toBe("invalid_token");
      expect(tenantRequests()).toEqual([]);
    });

    it("FM-06 an empty DPoP header counts as a DPoP header", async () => {
      const res = await postInitialize(server, `Bearer ${userToken}`, { dpop: "" });
      expect(res.status).toBe(401);
      expect(res.challenge?.params["error"]).toBe("invalid_token");
      expect(tenantRequests()).toEqual([]);
    });

    it("FM-06 the DPoP scheme is not a credential this server accepts: 401 and a Bearer-only challenge", async () => {
      const proof = await buildDpopProof(keys, { htm: "POST", htu: server.audience, accessToken: userToken });
      const res = await postInitialize(server, `DPoP ${userToken}`, { dpop: proof });
      expect(res.status).toBe(401);
      expect(res.challenge?.scheme).toBe("Bearer");
      expect(res.challenge?.params).not.toHaveProperty("algs");
      expect(tenantRequests()).toEqual([]);
    });

    it("FM-06 a real client that adds a DPoP header is refused with 401 and gets no session", async () => {
      const proof = await buildDpopProof(keys, { htm: "POST", htu: server.audience });
      const failure = await connect(server, userToken, { dpop: proof }).then(
        () => undefined,
        (error: Error & { seen: Array<{ status: number }> }) => error,
      );
      expect(failure).toBeDefined();
      expect(failure!.seen[0]!.status).toBe(401);
      expect(tenantRequests()).toEqual([]);
    });

    it("FM-06 control: the same token without the header is served, and that does reach the tenant", async () => {
      const res = await postInitialize(server, `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(tenantRequests().length).toBeGreaterThan(0);
    });
  });

  describe("a token bound to a DPoP key", () => {
    it("FM-06 is refused when presented as Bearer, or as DPoP with a valid proof", async (context) => {
      const bound = await requestDpopBoundUserToken(e2e, e2e.mcpAudience);
      if (bound === undefined) {
        context.skip(
          "pinned-tenant: the tenant ignores a DPoP proof at the token endpoint and issues an unbound Bearer token, so no key-bound token can be obtained without a tenant change",
        );
        return;
      }
      const server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url });
      try {
        const asBearer = await postInitialize(server, `Bearer ${bound.accessToken}`);
        expect(asBearer.status).toBe(401);
        expect(asBearer.challenge?.params["error"]).toBe("invalid_token");
        const proof = await buildDpopProof(bound.keys, { htm: "POST", htu: server.audience, accessToken: bound.accessToken });
        const asDpop = await postInitialize(server, `DPoP ${bound.accessToken}`, { dpop: proof });
        expect(asDpop.status).toBe(401);
        expect(asDpop.challenge?.scheme).toBe("Bearer");
      } finally {
        await server.stop();
      }
    });
  });
});
