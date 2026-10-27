import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callToolJson,
  connectMcpClient,
  getUserToken,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startWebMcpServer,
} from "./support/index.js";
import type { DelegateResult, DownstreamApi, E2eWebMcpServer } from "./support/index.js";

const e2e = loadE2eEnv();

/** A scope of the MCP API itself, which the signed-in test user holds. */
const CALLER_SCOPE = "tool:whoami";

describe("e2e web-standard transport", () => {
  let downstream: DownstreamApi;
  let server: E2eWebMcpServer;
  let userToken: string;

  beforeAll(async () => {
    userToken = await getUserToken(e2e, { scope: CALLER_SCOPE });
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    server = await startWebMcpServer({ env: e2e, downstreamUrl: downstream.url });
  });

  afterAll(async () => {
    await server?.close();
    await downstream?.close();
  });

  it("lists tools and runs whoami and delegate through the real SDK client", async () => {
    const session = await connectMcpClient(server.url, userToken);
    try {
      const tools = await session.client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("whoami");
      expect(names).toContain("delegate");

      const who = await callToolJson<{ sub: string; scopes: string[] }>(session.client, "whoami");
      expect(who.isError).toBe(false);
      expect(who.value.sub).toMatch(/\|/);
      expect(who.value.scopes).toContain(CALLER_SCOPE);

      const delegated = await callToolJson<DelegateResult>(session.client, "delegate");
      expect(delegated.isError).toBe(false);
      expect(delegated.value.status).toBe(200);
      // The downstream API verified the exchanged token against the tenant JWKS.
      expect(delegated.value.body["aud"]).toBe(e2e.downstreamAudience);
      expect(delegated.value.body["sub"]).toBe(who.value.sub);
      expect(delegated.value.grantedScopes).toContain(e2e.downstreamScope);
    } finally {
      await session.close();
    }
  });

  it("calls the handler directly with a Request", async () => {
    const response = await server.handle(
      new Request(server.htu, {
        method: "POST",
        headers: {
          authorization: `Bearer ${userToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toContain("delegate");
  });

  it("serves the protected resource metadata and its authorization server resolves to the tenant", async () => {
    const response = await fetch(server.metadataUrl);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(new URL(metadata.resource).href).toBe(new URL(e2e.mcpAudience).href);
    expect(metadata.authorization_servers).toEqual([e2e.issuer]);

    const discovery = await fetch(new URL(".well-known/openid-configuration", metadata.authorization_servers[0]));
    expect(discovery.status).toBe(200);
    const document = (await discovery.json()) as { issuer: string; jwks_uri: string };
    expect(document.issuer).toBe(e2e.issuer);
    expect(new URL(document.jwks_uri).host).toBe(e2e.domain);
  });

  it("rejects a POST to the metadata route with 405", async () => {
    const response = await fetch(server.metadataUrl, { method: "POST", body: "{}" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("answers a missing token with 401 and a resource_metadata URL for the metadata route", async () => {
    const res = await postInitialize(server.url);
    expect(res.status).toBe(401);
    expect(res.challenge?.scheme).toBe("Bearer");
    expect(res.challenge?.params).not.toHaveProperty("error");
    const advertised = res.challenge?.params["resource_metadata"] ?? "";
    // The handler advertises the public (resource origin) URL of the route the bridge serves locally.
    expect(new URL(advertised).pathname).toBe(server.metadataUrl.pathname);
    expect(new URL(advertised).origin).toBe(new URL(e2e.mcpAudience).origin);
  });

  it("rejects a garbage token with invalid_token", async () => {
    const res = await postInitialize(server.url, "Bearer not.a.token");
    expect(res.status).toBe(401);
    expect(res.challenge?.params["error"]).toBe("invalid_token");
  });

  it("answers GET and DELETE with a valid token with 405 and Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(server.url, {
        method,
        headers: { authorization: `Bearer ${userToken}`, accept: "application/json, text/event-stream" },
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("POST");
    }
  });

  it("authenticates before the method check: GET without a token gets 401", async () => {
    const response = await fetch(server.url, { method: "GET" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });
});
