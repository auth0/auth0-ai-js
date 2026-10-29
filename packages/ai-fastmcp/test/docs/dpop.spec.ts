import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import { createMcpClient } from "@auth0/ai-mcp";
import { createFastMcpAuth } from "../../src/index.js";
import { DOMAIN, INITIALIZE_BODY, createRig, parseChallenge, rawRequest, socketFetch, withServer } from "../integration/harness.js";
import { documented } from "./guides.js";
import { startDocsServer } from "./server.js";

/** Pins every claim of docs/DPoP.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const PROOF = "eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJqdGkiOiJ4In0.c2ln";
const DPOP_TEXT = "DPoP is not supported by this server.";
const BOUND_TEXT = "DPoP-bound access tokens are not supported by this server.";

function expectRefusal(response: Response, description: string, server: { origin: string; endpoint: string }) {
  expect(response.status).toBe(401);
  const challenge = parseChallenge(response.headers.get("www-authenticate"));
  expect(challenge.scheme).toBe("Bearer");
  expect(challenge.params["error"]).toBe("invalid_token");
  expect(challenge.params["error_description"]).toBe(description);
  expect(challenge.params["resource_metadata"]).toBe(`${server.origin}/.well-known/oauth-protected-resource${server.endpoint}`);
}

describe("DPoP.md: what the server does", () => {
  it.each([
    ["a DPoP header next to a valid Bearer token", true, PROOF],
    ["an empty DPoP header next to a valid Bearer token", true, ""],
    ["a DPoP header and no Authorization header", false, PROOF],
    ["an empty DPoP header and no Authorization header", false, ""],
  ])("refuses %s with 401 before any traffic to the tenant", async (_label, withToken, dpop) => {
    await withServer({}, async (server) => {
      const headers: Record<string, string> = { dpop };
      if (withToken) headers["authorization"] = `Bearer ${await rig().token(server)}`;
      expectRefusal(await rawRequest(server, { body: INITIALIZE_BODY, headers }), DPOP_TEXT, server);
      expect(rig().requests).toEqual([]);
    });
    documented(
      "DPoP.md",
      "| It has a `DPoP` header, even an empty one, with or without an `Authorization` header. |",
      "`DPoP is not supported by this server.`",
      "The first two refusals happen before the adapter contacts your tenant: it makes no discovery request and no key request.",
    );
  });

  it.each([
    ["a validly signed token", false],
    ["a token with a signature that does not verify", true],
  ])("refuses a Bearer token that claims a key binding (%s) with 401 before any traffic to the tenant", async (_label, spoil) => {
    await withServer({}, async (server) => {
      let token = await rig().token(server, { claims: { cnf: { jkt: "thumbprint" } } });
      if (spoil) token = `${token.split(".").slice(0, 2).join(".")}.AAAA`;
      const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
      expectRefusal(response, BOUND_TEXT, server);
      expect(await response.json()).toEqual({ error: "invalid_token", error_description: BOUND_TEXT });
      expect(rig().requests).toEqual([]);
    });
    documented(
      "DPoP.md",
      "It carries a Bearer token whose payload has a `cnf` claim",
      "`DPoP-bound access tokens are not supported by this server.`",
      "The adapter refuses a token that claims a binding whether or not its signature is good",
    );
  });

  it("treats the DPoP authorization scheme without a DPoP header as no credential", async () => {
    await withServer({}, async (server) => {
      const response = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `DPoP ${await rig().token(server)}` },
      });
      expect(response.status).toBe(401);
      const challenge = parseChallenge(response.headers.get("www-authenticate"));
      expect(challenge.scheme).toBe("Bearer");
      expect(challenge.params["error"]).toBeUndefined();
      expect(await response.json()).toEqual({ error: "unauthorized", error_description: "Authentication is required." });
    });
    documented("DPoP.md", "The scheme counts as no credential, like any scheme other than Bearer.");
  });

  it("lists the Bearer scheme only in every kind of challenge and never mentions DPoP in the metadata", async () => {
    await withServer({ auth: { requiredScopes: ["mcp:access"] } }, async (server) => {
      const challenges = [
        await rawRequest(server, { body: INITIALIZE_BODY }),
        await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: "Bearer a b" } }),
        await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: "Bearer abc.def.ghi" } }),
        await rawRequest(server, {
          body: INITIALIZE_BODY,
          headers: { authorization: `Bearer ${await rig().token(server, { scope: "other" })}` },
        }),
      ];
      expect(challenges.map((r) => r.status)).toEqual([401, 400, 401, 403]);
      for (const response of challenges) {
        const header = response.headers.get("www-authenticate") ?? "";
        expect(header.startsWith("Bearer")).toBe(true);
        expect(header.toLowerCase()).not.toContain("dpop");
      }
      const document = (await (await socketFetch(`${server.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
      expect(Object.keys(document).sort()).toEqual(["authorization_servers", "bearer_methods_supported", "resource"]);
    });
    documented(
      "DPoP.md",
      "Every challenge lists the `Bearer` scheme only, and the metadata document has no `dpop_signing_alg_values_supported` or `dpop_bound_access_tokens_required` field.",
    );
  });
});

describe("DPoP.md: the dpop option", () => {
  const base = { domain: DOMAIN, audience: "https://mcp.example.com/mcp" };

  it("accepts no mode, allowed and disabled, and throws for required with the documented message", () => {
    expect(() => createFastMcpAuth({ ...base })).not.toThrow();
    expect(() => createFastMcpAuth({ ...base, dpop: { mode: "allowed" } })).not.toThrow();
    expect(() => createFastMcpAuth({ ...base, dpop: { mode: "disabled" } })).not.toThrow();
    const call = () => createFastMcpAuth({ ...base, dpop: { mode: "required" } });
    expect(call).toThrow(InvalidConfigurationError);
    expect(call).toThrow(
      'DPoP mode "required" is not supported by the FastMCP adapter, which accepts Bearer tokens only. Use the default DPoP mode.',
    );
    documented(
      "DPoP.md",
      '`DPoP mode "required" is not supported by the FastMCP adapter, which accepts Bearer tokens only. Use the default DPoP mode.`',
      "| Not set, or `\"allowed\"` |",
      "| `\"disabled\"` |",
      "| `\"required\"` |",
    );
  });

  it("refuses a client that requires DPoP when it is passed in", () => {
    const client = createMcpClient({ ...base, dpop: { mode: "required" } });
    expect(() => createFastMcpAuth({ client })).toThrow(InvalidConfigurationError);
    documented("DPoP.md", "A client you pass in follows the same rules: when you create the adapter, `createFastMcpAuth` refuses one that requires DPoP.");
  });

  it("still refuses a token that claims a binding when the mode is disabled", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, dpop: { mode: "disabled" } }),
    });
    try {
      const bound = await rig().token(server, { claims: { cnf: { jkt: "thumbprint" } } });
      const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${bound}` } });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error_description: string }).error_description).toBe(BOUND_TEXT);
      const plain = await rig().token(server);
      expect((await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${plain}` } })).status).toBe(200);
    } finally {
      await server.stop();
    }
    documented("DPoP.md", "A token that claims a binding is still refused, because the `cnf` check does not depend on the mode.");
  });

  it("points at handlers of @auth0/ai-mcp that accept the DPoP scheme", async () => {
    const { createMcpHandler } = await import("@auth0/ai-mcp");
    const audience = "https://mcp.example.com/mcp";
    const handler = createMcpHandler({
      client: createMcpClient({ domain: DOMAIN, audience }),
      handler: async () => new Response("ok"),
    });
    const advertised = await handler(new Request(audience, { method: "POST" }));
    expect(advertised.headers.get("www-authenticate")).toMatch(/, DPoP /);
    documented(
      "DPoP.md",
      "serve MCP with `createMcpHandler` from `@auth0/ai-mcp`, or `createNodeMcpHandler` from `@auth0/ai-mcp/mcp-sdk`. Both accept the `DPoP` scheme.",
    );
  });
});
