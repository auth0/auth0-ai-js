/**
 * Discovery as a real client sees it: an unauthenticated request is answered with a challenge that
 * names the protected resource metadata, the metadata names the authorization server, and the
 * authorization server's own metadata is served by the live tenant. Then the resource indicator
 * (RFC 8707) is checked against the tenant with a real authorization code login.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_USER_VARS,
  decodeClaims,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { DownstreamApi, E2eMcpServer } from "./support/index.js";
import { loginOrgUser } from "./support/auth-code-token.js";

const groupSet = ORG_USER_VARS.some((name) => (process.env[name] ?? "") !== "");
const e2e = loadE2eEnv(groupSet ? ORG_USER_VARS : []);

const fetchJson = async (url: string | URL): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("e2e discovery", () => {
  let downstream: DownstreamApi;
  let server: E2eMcpServer;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    // The resource identifier is the MCP URL. When it is a loopback URL, listen on its port so the
    // metadata URL in the challenge is reachable exactly as a client would follow it.
    const resource = new URL(e2e.mcpAudience);
    const loopback = ["localhost", "127.0.0.1"].includes(resource.hostname);
    server = await startMcpServer({
      env: e2e,
      downstreamUrl: downstream.url,
      ...(loopback && resource.port !== "" && { port: Number(resource.port) }),
    });
  });

  afterAll(async () => {
    await server?.close();
    await downstream?.close();
  });

  it("E-D-01 a 401 leads to the resource metadata, the authorization server and its signing keys", async () => {
    const res = await postInitialize(server.url);
    expect(res.status).toBe(401);
    const metadataUrl = res.challenge?.params["resource_metadata"];
    expect(metadataUrl).toBeDefined();

    // Follow the URL from the challenge. A non-loopback resource cannot be reached from here, so
    // the same path is read from the local server instead.
    const advertised = new URL(metadataUrl!);
    expect(advertised.pathname).toMatch(/^\/\.well-known\/oauth-protected-resource/);
    const reachable = new URL(advertised.pathname + advertised.search, server.url.origin);
    const target = ["localhost", "127.0.0.1"].includes(advertised.hostname) && advertised.port === server.url.port ? advertised : reachable;

    const prm = await fetchJson(target);
    expect(prm.status).toBe(200);
    expect(prm.body["resource"]).toBe(e2e.mcpAudience);
    const servers = prm.body["authorization_servers"] as string[];
    expect(servers).toContain(e2e.issuer);

    // RFC 8414 metadata of the listed authorization server, served by the live tenant.
    const issuer = new URL(servers[0]!);
    const as = await fetchJson(new URL("/.well-known/oauth-authorization-server", issuer));
    expect(as.status).toBe(200);
    expect(as.body["issuer"]).toBe(e2e.issuer);
    expect(as.body["token_endpoint"]).toBe(`${e2e.issuer}oauth/token`);
    const jwksUri = as.body["jwks_uri"] as string;
    expect(jwksUri).toBe(`${e2e.issuer}.well-known/jwks.json`);

    // The advertised keys are the ones that verify tokens: the endpoint answers with a key set.
    const jwks = await fetchJson(jwksUri);
    expect(jwks.status).toBe(200);
    expect((jwks.body["keys"] as unknown[]).length).toBeGreaterThan(0);
  });

  it.skipIf(!groupSet)("E-D-02 authorize with only resource=<MCP URL> yields a token whose aud contains the MCP URL", async () => {
    // No `audience` parameter here: the tenant must map the resource indicator to the API.
    const login = await loginOrgUser(e2e, { organization: e2e.orgAId, audience: null, resource: e2e.mcpAudience });
    const aud = decodeClaims(login.accessToken)["aud"];
    expect(Array.isArray(aud) ? aud : [aud]).toContain(e2e.mcpAudience);

    // And the server accepts it.
    const res = await postInitialize(server.url, `Bearer ${login.accessToken}`);
    expect(res.status).toBe(200);
  });
});
