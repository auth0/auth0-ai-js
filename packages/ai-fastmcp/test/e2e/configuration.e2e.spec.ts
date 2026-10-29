/**
 * The configuration tiers of the adapter against the real tenant. The server under test gets its
 * client from `client` (a client built and passed in), `inline` (every connection setting passed as
 * an option), `env` (none passed; the four `AUTH0_` variables are read once, while the adapter is
 * built) or `partial` (client id and secret passed, domain and audience read from the environment).
 * Every tier must publish the same metadata, challenge the same way, and exchange for a real user.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callTool,
  connect,
  describeLive,
  firstUser,
  postInitialize,
  startDownstreamApi,
  startFastMcpServer,
  subjectOf,
} from "./support/index.js";
import type {
  DelegateResult,
  DownstreamApi,
  DownstreamClaimsBody,
  E2eConfigurationTier,
  FastMcpServer,
  WhoamiResult,
} from "./support/index.js";

const TIERS: E2eConfigurationTier[] = ["client", "inline", "env", "partial"];
const WELL_KNOWN = "/.well-known/oauth-protected-resource";

interface Observed {
  challenge: string | null;
  document: unknown;
}

describeLive("fastmcp configuration tiers", [], (e2e) => {
  const user = firstUser(e2e);
  let downstream: DownstreamApi;
  let userToken: string;
  const observed = new Map<E2eConfigurationTier, Observed>();

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await user.token();
  });

  afterAll(async () => {
    await downstream?.close();
  });

  describe.each(TIERS)("%s tier", (tier) => {
    let server: FastMcpServer;
    const before = {
      domain: process.env["AUTH0_DOMAIN"],
      audience: process.env["AUTH0_AUDIENCE"],
      clientId: process.env["AUTH0_CLIENT_ID"],
      clientSecret: process.env["AUTH0_CLIENT_SECRET"],
    };

    beforeAll(async () => {
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, configuration: tier });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("E-C-01 the server builds, and builds its client from the tier's own settings", () => {
      if (tier === "client") expect(server.client).toBeDefined();
      else expect(server.client).toBeUndefined();
    });

    it("E-C-01 the environment is read while the adapter is built and left as it was", () => {
      expect(process.env["AUTH0_DOMAIN"]).toBe(before.domain);
      expect(process.env["AUTH0_AUDIENCE"]).toBe(before.audience);
      expect(process.env["AUTH0_CLIENT_ID"]).toBe(before.clientId);
      expect(process.env["AUTH0_CLIENT_SECRET"]).toBe(before.clientSecret);
    });

    it("E-C-01 a request without a token gets the challenge of the configured resource; the document names the tenant", async () => {
      const refused = await postInitialize(server);
      expect(refused.status).toBe(401);
      const url = new URL(refused.challenge!.params["resource_metadata"]!);
      expect(url.pathname).toBe(`${WELL_KNOWN}${new URL(e2e.mcpAudience).pathname}`);
      const response = await fetch(new URL(url.pathname, server.origin), { headers: { connection: "close" } });
      expect(response.status).toBe(200);
      const document = (await response.json()) as Record<string, unknown>;
      expect(document["resource"]).toBe(e2e.mcpAudience);
      expect(document["authorization_servers"]).toEqual([e2e.issuer]);
      observed.set(tier, { challenge: refused.headers.get("www-authenticate"), document });
    });

    it("E-C-01 a live user token is verified and the session holds the caller", async () => {
      const session = await connect(server, userToken);
      try {
        const { isError, value } = await callTool<WhoamiResult>(session, "whoami");
        expect(isError).toBe(false);
        expect(value.sessionSub).toBe(subjectOf(userToken));
        expect(value.clientId).toBe(e2e.loginClientId);
      } finally {
        await session.close();
      }
    });

    it("E-C-01 the client built by the tier really exchanges: the downstream API sees the caller and the exchange client as actor", async () => {
      const session = await connect(server, userToken);
      try {
        const { isError, value } = await callTool<DelegateResult>(session, "delegate", { scope: "work:read" });
        expect(isError).toBe(false);
        expect(value.status).toBe(200);
        const claims = value.body as unknown as DownstreamClaimsBody;
        expect(claims.aud).toEqual(e2e.downstreamAudience);
        expect(claims.sub).toBe(subjectOf(userToken));
        expect(claims.act?.sub).toBe(e2e.oboClientId);
      } finally {
        await session.close();
      }
    });

    it("E-C-01 a garbage token is refused with invalid_token", async () => {
      const res = await postInitialize(server, "Bearer not.a.token");
      expect(res.status).toBe(401);
      expect(res.challenge?.params["error"]).toBe("invalid_token");
    });
  });

  it("E-C-01 all four tiers publish the same document and send the same challenge", () => {
    expect([...observed.keys()].sort()).toEqual([...TIERS].sort());
    const reference = observed.get("client")!;
    for (const tier of TIERS) {
      const entry = observed.get(tier)!;
      expect(entry.document, tier).toEqual(reference.document);
      expect(entry.challenge, tier).toBe(reference.challenge);
    }
  });

  it("E-C-01 a wrong client secret is accepted at construction and refused by the tenant at the exchange, with fixed text", async () => {
    const server = await startFastMcpServer({
      env: e2e,
      downstreamUrl: downstream.url,
      configuration: "inline",
      clientSecret: "wrong-secret-for-the-e2e-suite",
    });
    const session = await connect(server, userToken);
    try {
      // Verification needs no secret, so the caller is served.
      expect((await callTool(session, "whoami")).isError).toBe(false);
      const outcome = await callTool(session, "delegate", { scope: "work:read" });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe("Tool execution failed.");
      expect(outcome.text).not.toContain("wrong-secret");
    } finally {
      await session.close();
      await server.stop();
    }
  });
});
