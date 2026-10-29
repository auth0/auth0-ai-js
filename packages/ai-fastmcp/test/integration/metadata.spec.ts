import { buildProtectedResourceMetadata } from "@auth0/ai-mcp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMcpClient } from "@auth0/ai-mcp";
import { INITIALIZE_BODY, DOMAIN, createRig, parseChallenge, rawRequest, socketFetch, startServer, withServer } from "./harness.js";
import type { TestServer } from "./harness.js";

createRig({ beforeAll, afterEach, afterAll });

const MODES = [{ stateless: true }, { stateless: false }];
const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** Fetches the document the challenge names, the way a client does after a 401. */
async function followChallenge(server: TestServer): Promise<{ url: string; response: Response }> {
  const refused = await rawRequest(server, { body: INITIALIZE_BODY });
  expect(refused.status).toBe(401);
  const url = parseChallenge(refused.headers.get("www-authenticate")).params["resource_metadata"]!;
  expect(url).toBeDefined();
  return { url, response: await socketFetch(url) };
}

describe.each(MODES)("protected resource metadata (stateless: $stateless)", ({ stateless }) => {
  it("is served at the route the challenge names, and the resource is the audience", async () => {
    await withServer({ stateless }, async (server) => {
      const { url, response } = await followChallenge(server);
      expect(url).toBe(`${server.origin}${WELL_KNOWN}${server.endpoint}`);
      expect(response.status).toBe(200);
      const document = (await response.json()) as Record<string, unknown>;
      expect(document["resource"]).toBe(server.audience);
      expect(document["authorization_servers"]).toEqual([`https://${DOMAIN}/`]);
    });
  });

  it("is also served at the root well-known route", async () => {
    await withServer({ stateless }, async (server) => {
      const suffixed = await socketFetch(`${server.origin}${WELL_KNOWN}${server.endpoint}`);
      const root = await socketFetch(`${server.origin}${WELL_KNOWN}`);
      expect(root.status).toBe(200);
      expect(await root.json()).toEqual(await suffixed.json());
    });
  });

  it("equals the document buildProtectedResourceMetadata returns, without any DPoP field", async () => {
    await withServer({ stateless }, async (server) => {
      const { response } = await followChallenge(server);
      const served = (await response.json()) as Record<string, unknown>;
      const expected = buildProtectedResourceMetadata({
        client: createMcpClient({ domain: DOMAIN, audience: server.audience, dpop: { mode: "disabled" } }),
      });
      expect(served).toEqual(expected);
      expect(Object.keys(served).filter((key) => key.includes("dpop"))).toEqual([]);
      expect(served["bearer_methods_supported"]).toEqual(["header"]);
    });
  });

  it("needs no token", async () => {
    await withServer({ stateless }, async (server) => {
      const response = await socketFetch(`${server.origin}${WELL_KNOWN}${server.endpoint}`, {
        headers: { authorization: "Bearer garbage" },
      });
      expect(response.status).toBe(200);
    });
  });

  it("publishes the optional fields", async () => {
    await withServer(
      {
        stateless,
        auth: {
          authorizationServers: ["https://issuer.example.com/"],
          metadata: { scopesSupported: ["read:orders", "write:orders"], resourceName: "Orders", resourceDocumentation: "https://docs.example.com/orders" },
        },
      },
      async (server) => {
        const { response } = await followChallenge(server);
        expect(await response.json()).toMatchObject({
          authorization_servers: ["https://issuer.example.com/"],
          scopes_supported: ["read:orders", "write:orders"],
          resource_name: "Orders",
          resource_documentation: "https://docs.example.com/orders",
        });
      },
    );
  });

  it("agrees with the challenge on a custom endpoint, and the old route is gone", async () => {
    await withServer({ stateless, endpoint: "/api/mcp" }, async (server) => {
      const { url, response } = await followChallenge(server);
      expect(url).toBe(`${server.origin}${WELL_KNOWN}/api/mcp`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as Record<string, unknown>)["resource"]).toBe(`${server.origin}/api/mcp`);
      expect((await socketFetch(`${server.origin}${WELL_KNOWN}/mcp`)).status).toBe(404);
    });
  });

  it("agrees with the challenge when the resource is the origin alone", async () => {
    await withServer({ stateless, resourceAtRoot: true }, async (server) => {
      const { url, response } = await followChallenge(server);
      expect(url).toBe(`${server.origin}${WELL_KNOWN}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as Record<string, unknown>)["resource"]).toBe(server.origin);
    });
  });

  it("does not follow X-Forwarded headers", async () => {
    await withServer({ stateless }, async (server) => {
      const response = await socketFetch(`${server.origin}${WELL_KNOWN}${server.endpoint}`, {
        headers: { "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" },
      });
      expect(((await response.json()) as Record<string, unknown>)["resource"]).toBe(server.audience);
    });
  });
});

describe("metadata configuration", () => {
  it("refuses a resource path that FastMCP would not serve the document for", async () => {
    await expect(startServer({ endpoint: "/mcp", clientOptions: { audience: "http://127.0.0.1:9/other" } })).rejects.toThrow(
      /must equal "endpoint"/,
    );
  });
});
