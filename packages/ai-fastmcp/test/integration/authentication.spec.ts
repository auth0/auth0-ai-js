import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { mintUnsignedToken, createTestKey } from "../support/index.js";
import { INITIALIZE_BODY, callTool, connect, createRig, parseChallenge, rawRequest, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

const MODES = [{ stateless: true }, { stateless: false }];

function metadataUrlOf(server: { origin: string; endpoint: string }): string {
  return `${server.origin}/.well-known/oauth-protected-resource${server.endpoint}`;
}

describe.each(MODES)("authentication (stateless: $stateless)", ({ stateless }) => {
  describe("a valid token", () => {
    it("connects and serves a tool call", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server, { sub: "user|alice" }));
        try {
          const { isError, value } = await callTool<{ sessionSub: string }>(session, "whoami");
          expect(isError).toBe(false);
          expect(value.sessionSub).toBe("user|alice");
        } finally {
          await session.close();
        }
      });
    });
  });

  describe("a request without a token", () => {
    it("is refused with 401, a Bearer challenge that names the metadata and no error value", async () => {
      await withServer({ stateless }, async (server) => {
        const response = await rawRequest(server, { body: INITIALIZE_BODY });
        expect(response.status).toBe(401);
        const challenge = parseChallenge(response.headers.get("www-authenticate"));
        expect(challenge.scheme).toBe("Bearer");
        expect(challenge.params).toEqual({ resource_metadata: metadataUrlOf(server) });
        expect(await response.json()).toEqual({
          error: "unauthorized",
          error_description: "Authentication is required.",
        });
      });
    });

    it("is refused for a real client, which sees the 401", async () => {
      await withServer({ stateless }, async (server) => {
        const failure = await connect(server).then(
          () => undefined,
          (error: Error & { seen: Array<{ status: number; wwwAuthenticate: string | null }> }) => error,
        );
        expect(failure).toBeDefined();
        expect(failure!.seen[0]!.status).toBe(401);
        expect(parseChallenge(failure!.seen[0]!.wwwAuthenticate).params["resource_metadata"]).toBe(
          metadataUrlOf(server),
        );
      });
    });
  });

  describe("a thrown Response reaches the client as it is", () => {
    it("keeps status, headers and body byte for byte", async () => {
      await withServer({ stateless }, async (server) => {
        const response = await rawRequest(server, {
          body: INITIALIZE_BODY,
          headers: { authorization: "Bearer not-a-jwt" },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toMatch(/^application\/json/);
        expect(response.headers.get("www-authenticate")).toBe(
          `Bearer error="invalid_token", error_description="The access token is invalid or has expired.", resource_metadata="${metadataUrlOf(server)}"`,
        );
        expect(await response.text()).toBe(
          '{"error":"invalid_token","error_description":"The access token is invalid or has expired."}',
        );
      });
    });
  });

  describe("tokens that must be refused with 401 and an invalid_token challenge", () => {
    const now = () => Math.floor(Date.now() / 1000);
    const cases: Array<[string, (server: { audience: string }) => Promise<string>]> = [
      ["not a JWT", async () => "not-a-jwt"],
      ["expired", (server) => rig().token(server, { exp: now() - 3600, iat: now() - 7200 })],
      ["issued for another audience", (server) => rig().token(server, { aud: `${server.audience}/other` })],
      ["issued by another issuer", (server) => rig().token(server, { iss: "https://evil.example.com/" })],
      [
        "signed with another key",
        async (server) => {
          // Same key id as the tenant's key, different key material.
          const other = await createTestKey({ kid: rig().tenant.key.kid });
          return new SignJWT({ scope: "read:orders" })
            .setProtectedHeader({ alg: other.alg, kid: other.kid })
            .setIssuer(rig().tenant.auth0.issuer)
            .setAudience(server.audience)
            .setSubject("user|mallory")
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(other.privateKey);
        },
      ],
      ["unsigned (alg none)", async (server) => mintUnsignedToken({ iss: rig().tenant.auth0.issuer, aud: server.audience, sub: "user|1", exp: now() + 3600, iat: now() })],
      ["without a subject", (server) => rig().token(server, { sub: false })],
      ["without an expiry", (server) => rig().token(server, { exp: false })],
    ];

    it.each(cases)("%s", async (_name, mint) => {
      await withServer({ stateless }, async (server) => {
        const token = await mint(server);
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(401);
        const challenge = parseChallenge(response.headers.get("www-authenticate"));
        expect(challenge.scheme).toBe("Bearer");
        expect(challenge.params["error"]).toBe("invalid_token");
        expect(challenge.params["resource_metadata"]).toBe(metadataUrlOf(server));
        const text = await response.text();
        expect(text).not.toContain(token);
        expect(JSON.parse(text)).toEqual({
          error: "invalid_token",
          error_description: "The access token is invalid or has expired.",
        });
        await expect(connect(server, token)).rejects.toBeDefined();
      });
    });
  });

  describe("a malformed Authorization header", () => {
    it.each([["Bearer a b"], ["Bearer"], ["Bearer  "]])("%j is refused with 400 or 401, never accepted", async (header) => {
      await withServer({ stateless }, async (server) => {
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: header } });
        expect([400, 401]).toContain(response.status);
        expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
      });
    });

    it("answers a multi-token header with 400 invalid_request", async () => {
      await withServer({ stateless }, async (server) => {
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: "Bearer a b" } });
        expect(response.status).toBe(400);
        expect(parseChallenge(response.headers.get("www-authenticate")).params["error"]).toBe("invalid_request");
      });
    });

    it("treats another scheme like a missing credential", async () => {
      await withServer({ stateless }, async (server) => {
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: "Basic dXNlcjpwYXNz" } });
        expect(response.status).toBe(401);
        expect(parseChallenge(response.headers.get("www-authenticate")).params["error"]).toBeUndefined();
      });
    });
  });

  describe("server-wide required scopes", () => {
    it("refuses a token without them with 403 and names them in the challenge", async () => {
      await withServer({ stateless, auth: { requiredScopes: ["read:orders", "mcp:access"] } }, async (server) => {
        const token = await rig().token(server, { scope: "read:orders" });
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(403);
        const challenge = parseChallenge(response.headers.get("www-authenticate"));
        expect(challenge.params["error"]).toBe("insufficient_scope");
        expect(challenge.params["scope"]).toBe("mcp:access");
        expect(challenge.params["resource_metadata"]).toBe(metadataUrlOf(server));
        expect(await response.json()).toEqual({
          error: "insufficient_scope",
          error_description: "The access token does not include the required scope.",
        });
        await expect(connect(server, token)).rejects.toBeDefined();
      });
    });

    it("refuses a token that carries no scope claim", async () => {
      await withServer({ stateless, auth: { requiredScopes: ["mcp:access"] } }, async (server) => {
        const token = await rig().token(server, {});
        const noScope = await rig().token(server, { scope: "" });
        for (const candidate of [token, noScope]) {
          const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${candidate}` } });
          expect(response.status).toBe(403);
        }
      });
    });

    it("serves a token that holds them", async () => {
      await withServer({ stateless, auth: { requiredScopes: ["mcp:access"] } }, async (server) => {
        const session = await connect(server, await rig().token(server, { scope: "mcp:access read:orders" }));
        try {
          expect((await callTool(session, "whoami")).isError).toBe(false);
        } finally {
          await session.close();
        }
      });
    });
  });

  describe("the realm", () => {
    it("appears in every challenge", async () => {
      await withServer({ stateless, auth: { realm: "orders" } }, async (server) => {
        const response = await rawRequest(server, { body: INITIALIZE_BODY });
        expect(parseChallenge(response.headers.get("www-authenticate")).params["realm"]).toBe("orders");
      });
    });
  });
});
