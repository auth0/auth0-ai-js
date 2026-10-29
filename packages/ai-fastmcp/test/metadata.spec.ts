import { buildProtectedResourceMetadata } from "@auth0/ai-mcp";
import { describe, expect, it } from "vitest";
import { buildProtectedResource } from "../src/metadata.js";
import { bearerOnly } from "../src/options.js";
import { AUDIENCE, stubClient } from "./support/stubs.js";

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** FastMCP's own conversion when it serves the block. */
function servedByFastMcp(block: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(block).map(([key, value]) => [snake(key), value]));
}

describe("buildProtectedResource", () => {
  it("serves the same document buildProtectedResourceMetadata returns", () => {
    const client = bearerOnly(stubClient());
    const options = {
      authorizationServers: ["https://issuer.example.com/", "https://other.example.com/"],
      metadata: { scopesSupported: ["a", "b"], resourceName: "Orders", resourceDocumentation: "https://docs.example.com" },
    };
    const block = buildProtectedResource(client, options);
    expect(servedByFastMcp(block)).toEqual(
      buildProtectedResourceMetadata({
        client,
        authorizationServers: options.authorizationServers,
        scopesSupported: options.metadata.scopesSupported,
        resourceName: options.metadata.resourceName,
        resourceDocumentation: options.metadata.resourceDocumentation,
      }),
    );
  });

  it("uses camelCase keys, which FastMCP turns into the RFC 9728 names", () => {
    const block = buildProtectedResource(bearerOnly(stubClient()), {});
    expect(block).toMatchObject({
      resource: AUDIENCE,
      authorizationServers: ["https://tenant.example.com/"],
      bearerMethodsSupported: ["header"],
    });
    expect(Object.keys(servedByFastMcp(block))).toContain("authorization_servers");
  });

  it("never promises DPoP, whatever the DPoP mode of the real client", () => {
    for (const dpopMode of ["allowed", "disabled"] as const) {
      const block = buildProtectedResource(bearerOnly(stubClient({ dpopMode })), {});
      const keys = Object.keys(servedByFastMcp(block));
      expect(keys.filter((key) => key.includes("dpop"))).toEqual([]);
    }
  });

  it("leaves out the optional fields that are not set", () => {
    const keys = Object.keys(buildProtectedResource(bearerOnly(stubClient()), {})).sort();
    expect(keys).toEqual(["authorizationServers", "bearerMethodsSupported", "resource"]);
  });

  it("defaults the resource to the audience and rejects a different one", () => {
    expect(buildProtectedResource(bearerOnly(stubClient()), {}).resource).toBe(AUDIENCE);
    expect(() => buildProtectedResource(bearerOnly(stubClient()), { resource: "https://other.example.com/mcp" })).toThrow(
      /must equal the client audience/,
    );
  });
});
