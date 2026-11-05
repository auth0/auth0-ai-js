/**
 * Discovery through a real FastMCP server, against the real tenant: the 401 challenge names a
 * metadata URL, the running server serves the document at that URL, and the document leads to the
 * tenant's authorization server. The MCP SDK's own discovery helpers follow the same chain a real
 * client does.
 */
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeLive, postInitialize, startDownstreamApi, startFastMcpServer } from "./support/index.js";
import type { DownstreamApi, FastMcpServer } from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

describeLive("fastmcp metadata and discovery", [], (e2e) => {
  let downstream: DownstreamApi;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
  });

  afterAll(async () => {
    await downstream?.close();
  });

  /**
   * Fetches a URL the challenge named from the running server. The challenge is built from the
   * audience, so when that is not the local address the request is sent to the local server with
   * the same path.
   */
  const fetchFromServer = (server: FastMcpServer, advertised: string): Promise<Response> => {
    const url = new URL(advertised);
    return fetch(new URL(`${url.pathname}${url.search}`, server.origin), { headers: { connection: "close" } });
  };

  describe.each(MODES)("$label server", ({ stateless }) => {
    let server: FastMcpServer;

    beforeAll(async () => {
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless });
    });

    afterAll(async () => {
      await server?.stop();
    });

    async function advertisedUrl(): Promise<string> {
      const refused = await postInitialize(server);
      expect(refused.status).toBe(401);
      const url = refused.challenge?.params["resource_metadata"];
      expect(url).toBeDefined();
      return url!;
    }

    it("E-D-01 the challenge names the metadata route of the server's own resource", async () => {
      const url = new URL(await advertisedUrl());
      expect(url.origin).toBe(new URL(e2e.mcpAudience).origin);
      expect(url.pathname).toBe(`${WELL_KNOWN}${new URL(e2e.mcpAudience).pathname}`);
    });

    it("E-D-01 the running server serves the document there: the resource is the audience, the authorization server is the tenant", async () => {
      const response = await fetchFromServer(server, await advertisedUrl());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      const document = (await response.json()) as Record<string, unknown>;
      expect(document["resource"]).toBe(e2e.mcpAudience);
      expect(document["authorization_servers"]).toEqual([e2e.issuer]);
      expect(document["bearer_methods_supported"]).toEqual(["header"]);
      expect(Object.keys(document).filter((key) => key.includes("dpop"))).toEqual([]);
    });

    it("E-D-01 the root route serves the same document as the suffixed route", async () => {
      const suffixed = await fetchFromServer(server, await advertisedUrl());
      const root = await fetch(`${server.origin}${WELL_KNOWN}`, { headers: { connection: "close" } });
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual(await suffixed.json());
    });

    it("E-D-01 the document needs no token, even when a bad one is sent", async () => {
      const url = new URL(await advertisedUrl());
      const response = await fetch(new URL(url.pathname, server.origin), {
        headers: { authorization: "Bearer not.a.token", connection: "close" },
      });
      expect(response.status).toBe(200);
    });

    it("E-D-01 the MCP SDK follows the challenge to the document, then to the tenant's authorization server", async () => {
      const advertised = await advertisedUrl();
      const document = await discoverOAuthProtectedResourceMetadata(
        server.url,
        { resourceMetadataUrl: advertised },
        (input) => fetchFromServer(server, String(input)),
      );
      expect(document.resource).toBe(e2e.mcpAudience);
      const authorizationServer = document.authorization_servers?.[0];
      expect(authorizationServer).toBe(e2e.issuer);

      const metadata = await discoverAuthorizationServerMetadata(authorizationServer!);
      expect(metadata?.issuer).toBe(e2e.issuer);
      expect(metadata?.token_endpoint).toBe(`${e2e.issuer}oauth/token`);
      expect(new URL(String((metadata as Record<string, unknown>)["jwks_uri"])).host).toBe(e2e.domain);
    });

    it("E-D-01 the SDK also finds the document from the server URL alone, by its own path rule", async () => {
      const document = await discoverOAuthProtectedResourceMetadata(server.url, undefined, (input) =>
        fetchFromServer(server, String(input)),
      );
      expect(document.resource).toBe(e2e.mcpAudience);
    });
  });
});
