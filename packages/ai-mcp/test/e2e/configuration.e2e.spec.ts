/**
 * Handlers configured without a client object, against the real tenant. The server under test is
 * built with the one-call tiers: `env` (the handler reads AUTH0_DOMAIN, AUTH0_AUDIENCE,
 * AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET) and `inline` (the same values as handler options).
 * Neither passes `resource` or `authorizationServers`, so the discovery chain a client follows
 * must work on the defaults: the challenge names a metadata route, the suffixed and the root route
 * both serve the document, and the document names the live tenant as the authorization server.
 * An exchange then goes through the live tenant to prove the built client really performs it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callToolJson,
  connectMcpClient,
  getUserToken,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
  startWebMcpServer,
} from "./support/index.js";
import type {
  DelegateResult,
  DownstreamApi,
  DownstreamClaimsBody,
  E2eConfigurationTier,
  E2eMcpServer,
} from "./support/index.js";

const e2e = loadE2eEnv();

const WELL_KNOWN = "/.well-known/oauth-protected-resource";
const suffixedPath = `${WELL_KNOWN}${new URL(e2e.mcpAudience).pathname.replace(/\/$/, "")}`;

const fetchJson = async (url: URL): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe.each<[E2eConfigurationTier]>([["env"], ["inline"]])("e2e one-call configuration (%s tier)", (tier) => {
  let downstream: DownstreamApi;
  let server: E2eMcpServer;
  let userToken: string;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url, configuration: tier });
    userToken = await getUserToken(e2e);
  });

  afterAll(async () => {
    await server?.close();
    await downstream?.close();
  });

  it("builds no client object in the support code", () => {
    expect(server.client).toBeUndefined();
  });

  it("answers 401 with a challenge that names the suffixed metadata route", async () => {
    const res = await postInitialize(server.url);
    expect(res.status).toBe(401);
    const advertised = new URL(res.challenge!.params["resource_metadata"]!);
    expect(advertised.pathname).toBe(suffixedPath);
    expect(advertised.origin).toBe(new URL(e2e.mcpAudience).origin);
  });

  it("serves the same document at the suffixed and the root route, naming the live tenant", async () => {
    const suffixed = await fetchJson(new URL(suffixedPath, server.url.origin));
    const root = await fetchJson(new URL(WELL_KNOWN, server.url.origin));
    expect(suffixed.status).toBe(200);
    expect(root.status).toBe(200);
    expect(root.body).toEqual(suffixed.body);
    expect(suffixed.body["resource"]).toBe(e2e.mcpAudience);
    expect(suffixed.body["authorization_servers"]).toEqual([e2e.issuer]);

    // The listed authorization server is the live tenant, and it serves its own metadata.
    const as = await fetchJson(new URL("/.well-known/oauth-authorization-server", e2e.issuer));
    expect(as.status).toBe(200);
    expect(as.body["issuer"]).toBe(e2e.issuer);
  });

  it("agrees across the chain: challenge route, both routes and the resource all match", async () => {
    const res = await postInitialize(server.url);
    const advertised = new URL(res.challenge!.params["resource_metadata"]!);
    const followed = await fetchJson(new URL(advertised.pathname, server.url.origin));
    const root = await fetchJson(new URL(WELL_KNOWN, server.url.origin));
    expect(followed.body).toEqual(root.body);
    expect(followed.body["resource"]).toBe(e2e.mcpAudience);
  });

  it("verifies a live user token and exchanges it on behalf of the caller", async () => {
    const session = await connectMcpClient(server.url, userToken);
    try {
      const who = await callToolJson<{ sub: string }>(session.client, "whoami");
      expect(who.isError).toBe(false);

      const { isError, value } = await callToolJson<DelegateResult>(session.client, "delegate", {
        scope: "work:read",
      });
      expect(isError).toBe(false);
      expect(value.status).toBe(200);
      expect(value.grantedScopes).toContain("work:read");
      const claims = value.body as unknown as DownstreamClaimsBody;
      expect(claims.ok).toBe(true);
      expect(claims.aud).toEqual(e2e.downstreamAudience);
      expect(claims.sub).toBe(who.value.sub);
      expect(claims.act?.sub).toBe(e2e.oboClientId);
    } finally {
      await session.close();
    }
  });

  it("rejects a garbage token with invalid_token", async () => {
    const res = await postInitialize(server.url, "Bearer not.a.token");
    expect(res.status).toBe(401);
    expect(res.challenge?.params["error"]).toBe("invalid_token");
  });
});

describe("e2e one-call configuration (web handler, env tier)", () => {
  let downstream: DownstreamApi;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
  });

  afterAll(async () => {
    await downstream?.close();
  });

  it("serves both metadata routes and an exchange through the web-standard handler", async () => {
    const web = await startWebMcpServer({ env: e2e, downstreamUrl: downstream.url, configuration: "env" });
    try {
      const suffixed = await fetchJson(web.metadataUrl);
      const root = await fetchJson(new URL(WELL_KNOWN, web.url.origin));
      expect(suffixed.status).toBe(200);
      expect(root.body).toEqual(suffixed.body);
      expect(suffixed.body["resource"]).toBe(e2e.mcpAudience);

      const session = await connectMcpClient(web.url, await getUserToken(e2e));
      try {
        const { isError, value } = await callToolJson<DelegateResult>(session.client, "delegate", {
          scope: "work:read",
        });
        expect(isError).toBe(false);
        expect(value.status).toBe(200);
      } finally {
        await session.close();
      }
    } finally {
      await web.close();
    }
  });
});
