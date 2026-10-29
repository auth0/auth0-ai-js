import type { IncomingMessage } from "node:http";
import { AuthError, InvalidConfigurationError, VerifyAccessTokenError } from "@auth0/auth0-api-js";
import { authenticateRequest } from "@auth0/ai-mcp";
import type { RejectedRequest } from "@auth0/ai-mcp";
import { describe, expect, it, vi } from "vitest";
import { createFastMcpAuth } from "../src/create.js";
import { bearerOnly } from "../src/options.js";
import type { FastMcpAuthOptions } from "../src/options.js";
import {
  AUDIENCE,
  bearer,
  callerFor,
  fakeJwt,
  fakeRequest,
  principalOf,
  stubClient,
  thrown,
} from "./support/stubs.js";

const METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

function setup(options: Partial<FastMcpAuthOptions> = {}, clientOptions: Parameters<typeof stubClient>[0] = {}) {
  const client = stubClient(clientOptions);
  const auth = createFastMcpAuth({ client, ...options } as FastMcpAuthOptions);
  return { client, auth };
}

async function failure(promise: Promise<unknown>): Promise<Response> {
  const error = await thrown(promise);
  expect(error).toBeInstanceOf(Response);
  return error as Response;
}

describe("createFastMcpAuth", () => {
  describe("construction", () => {
    it("returns exactly authenticate and oauth", () => {
      const { auth } = setup();
      expect(Object.keys(auth).sort()).toEqual(["authenticate", "oauth"]);
      expect(auth.oauth.enabled).toBe(true);
    });

    it("rejects a client combined with an inline client option", () => {
      expect(() =>
        createFastMcpAuth({ client: stubClient(), audience: AUDIENCE } as unknown as FastMcpAuthOptions),
      ).toThrow(InvalidConfigurationError);
    });

    it("rejects a client that requires DPoP", () => {
      expect(() => setup({}, { dpopMode: "required" })).toThrow(/DPoP mode "required"/);
    });

    it("rejects a resource that differs from the client audience", () => {
      expect(() => setup({ resource: "https://other.example.com/mcp" })).toThrow(InvalidConfigurationError);
    });

    it("rejects a resource path that is not the endpoint", () => {
      expect(() => setup({ resource: AUDIENCE, endpoint: "/api/mcp" })).toThrow(/must equal "endpoint"/);
    });

    it("rejects an audience that is not a URL when no resource is given", () => {
      expect(() => setup({}, { audience: "urn:orders" })).toThrow(/needs the public URL of this MCP server/);
    });

    it("rejects a bad realm, endpoint and binding limit", () => {
      expect(() => setup({ realm: 'a"b' })).toThrow(InvalidConfigurationError);
      expect(() => setup({ endpoint: "/mcp/" })).toThrow(InvalidConfigurationError);
      expect(() => setup({ sessionBinding: { ttlMs: 0 } })).toThrow(InvalidConfigurationError);
    });

    it("rejects authorization servers it cannot derive", () => {
      expect(() => setup({}, { domain: undefined })).toThrow(/"authorizationServers" is required/);
      expect(() => setup({ authorizationServers: ["https://issuer.example.com/"] }, { domain: undefined })).not.toThrow();
    });
  });

  describe("session", () => {
    it("returns a frozen session with principal, scopes and the scoped client", async () => {
      const principal = principalOf({ scopes: ["a", "b"] });
      const { auth } = setup({}, { verify: async () => callerFor(principal) });
      const session = await auth.authenticate(fakeRequest(bearer(fakeJwt())));
      expect(session.principal).toBe(principal);
      expect(session.scopes).toEqual(["a", "b"]);
      expect(Array.isArray(session.scopes)).toBe(true);
      expect(session.mcpClient.getPrincipal()).toBe(principal);
      expect(Object.isFrozen(session)).toBe(true);
      expect(Object.keys(session).sort()).toEqual(["mcpClient", "principal", "scopes"]);
    });

    it("never puts the bearer token into the session", async () => {
      const token = fakeJwt({ marker: "token-marker-123" });
      const { auth } = setup();
      const session = await auth.authenticate(fakeRequest(bearer(token)));
      expect(JSON.stringify(session)).not.toContain(token);
      expect(JSON.stringify(session)).not.toContain("token-marker-123");
    });

    it("verifies with the bearer scheme and the token from the header", async () => {
      const { auth, client } = setup();
      await auth.authenticate(fakeRequest(bearer(fakeJwt())));
      expect(client.verifyCalls).toHaveLength(1);
      expect(client.verifyCalls[0]).toMatchObject({ scheme: "bearer" });
    });
  });

  describe("failures are thrown Responses", () => {
    it("answers a missing Authorization header with 401 and a challenge without an error value", async () => {
      const { auth, client } = setup();
      const response = await failure(auth.authenticate(fakeRequest()));
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate")!;
      expect(challenge).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
      expect(client.verifyCalls).toHaveLength(0);
    });

    it("answers a malformed header with 400", async () => {
      const { auth } = setup();
      const response = await failure(auth.authenticate(fakeRequest({ authorization: "Bearer a b" })));
      expect(response.status).toBe(400);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_request"');
    });

    it("answers an unknown scheme like a missing credential", async () => {
      const { auth } = setup();
      const response = await failure(auth.authenticate(fakeRequest({ authorization: "Basic abc" })));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).not.toContain("error=");
    });

    it("answers a rejected token with 401 invalid_token and a generic body", async () => {
      const { auth } = setup(
        {},
        { verify: async () => Promise.reject(new VerifyAccessTokenError("signature check failed for key abc")) },
      );
      const response = await failure(auth.authenticate(fakeRequest(bearer(fakeJwt()))));
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate")!;
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
      const text = await response.text();
      expect(text).not.toContain("signature check");
      expect(challenge).not.toContain("signature check");
      expect(JSON.parse(text)).toMatchObject({ error: "invalid_token" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json");
    });

    it("maps a core error with a 403 status to 403 insufficient_scope", async () => {
      const { auth } = setup(
        {},
        { verify: async () => Promise.reject(new AuthError("forbidden by policy", "access_denied", 403)) },
      );
      const response = await failure(auth.authenticate(fakeRequest(bearer(fakeJwt()))));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("policy");
    });

    it("enforces the server-wide scopes with 403 and names them in the challenge", async () => {
      const { auth } = setup(
        { requiredScopes: ["read:orders", "write:orders"] },
        { verify: async () => callerFor(principalOf({ scopes: ["read:orders"] })) },
      );
      const response = await failure(auth.authenticate(fakeRequest(bearer(fakeJwt()))));
      expect(response.status).toBe(403);
      const challenge = response.headers.get("www-authenticate")!;
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain('scope="write:orders"');
    });

    it("accepts a caller that holds every server-wide scope", async () => {
      const { auth } = setup(
        { requiredScopes: ["read:orders"] },
        { verify: async () => callerFor(principalOf({ scopes: ["read:orders", "extra"] })) },
      );
      await expect(auth.authenticate(fakeRequest(bearer(fakeJwt())))).resolves.toBeDefined();
    });

    it("adds the realm to every challenge", async () => {
      const { auth } = setup({ realm: "orders" });
      const response = await failure(auth.authenticate(fakeRequest()));
      expect(response.headers.get("www-authenticate")).toContain('realm="orders"');
    });

    it("advertises Bearer only, whatever the DPoP mode of the client", async () => {
      for (const dpopMode of ["allowed", "disabled"] as const) {
        const { auth } = setup({}, { dpopMode });
        const response = await failure(auth.authenticate(fakeRequest()));
        expect(response.headers.get("www-authenticate")).not.toMatch(/dpop/i);
      }
    });
  });

  describe("never throws a plain error", () => {
    it("turns an unexpected error into a generic 500 and reports the raw error", async () => {
      const onError = vi.fn();
      const boom = new Error("secret internal detail xyz");
      const { auth } = setup({ onError }, { verify: async () => Promise.reject(boom) });
      const response = await failure(auth.authenticate(fakeRequest(bearer(fakeJwt()))));
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("secret");
      expect(JSON.parse(text)).toEqual({ error: "server_error", error_description: "Internal server error." });
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(boom);
    });

    it("keeps the 500 when the error hook throws or rejects", async () => {
      for (const onError of [
        () => {
          throw new Error("hook failed");
        },
        () => Promise.reject(new Error("hook failed")),
      ]) {
        const { auth } = setup({ onError }, { verify: async () => Promise.reject(new Error("x")) });
        const response = await failure(auth.authenticate(fakeRequest(bearer(fakeJwt()))));
        expect(response.status).toBe(500);
      }
    });

    it("turns a non-error throw into a 500", async () => {
      const { auth } = setup({}, { verify: async () => Promise.reject("a string") });
      const response = await failure(auth.authenticate(fakeRequest(bearer(fakeJwt()))));
      expect(response.status).toBe(500);
    });

    it("turns a fault of its own into a generic 500 instead of throwing it", async () => {
      const onError = vi.fn();
      const { auth } = setup({ onError });
      // A request without headers makes the adapter's own code throw a TypeError.
      const broken = { url: "/mcp" } as unknown as IncomingMessage;
      const response = await failure(auth.authenticate(broken));
      expect(response.status).toBe(500);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.json()).toEqual({ error: "server_error", error_description: "Internal server error." });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(TypeError);
    });

    it("keeps that 500 when the error hook throws, and when there is no hook", async () => {
      const broken = { url: "/mcp" } as unknown as IncomingMessage;
      const throwing = setup({
        onError: () => {
          throw new Error("hook failed");
        },
      });
      expect((await failure(throwing.auth.authenticate(broken))).status).toBe(500);
      const none = setup();
      expect((await failure(none.auth.authenticate(broken))).status).toBe(500);
    });

    it("answers a request that cannot become a Request with 400", async () => {
      const { auth } = setup();
      const response = await failure(auth.authenticate(fakeRequest({ authorization: "Bearer abcĀ" })));
      expect(response.status).toBe(400);
      expect(response.headers.get("www-authenticate")).toBeNull();
    });

    it("survives a request without a url", async () => {
      const { auth } = setup();
      const request = fakeRequest(bearer(fakeJwt()));
      Object.assign(request, { url: undefined });
      await expect(auth.authenticate(request)).resolves.toBeDefined();
    });
  });

  describe("DPoP", () => {
    it("refuses a DPoP header with 401 and a Bearer challenge, before any verification", async () => {
      const { auth, client } = setup();
      const response = await failure(auth.authenticate(fakeRequest({ ...bearer(fakeJwt()), dpop: "proof" })));
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate")!;
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain("DPoP is not supported");
      expect(challenge).not.toMatch(/^DPoP|, DPoP /);
      expect(client.verifyCalls).toHaveLength(0);
    });

    it("recognizes a key-bound token under any spelling of the Bearer scheme", async () => {
      const { auth, client } = setup({}, { dpopMode: "disabled" });
      for (const scheme of ["bearer", "BEARER", "Bearer"]) {
        const response = await failure(
          auth.authenticate(fakeRequest({ authorization: `${scheme} ${fakeJwt({ cnf: { jkt: "t" } })}` })),
        );
        expect(response.status).toBe(401);
      }
      expect(client.verifyCalls).toHaveLength(0);
    });

    it("refuses an empty DPoP header too", async () => {
      const { auth, client } = setup();
      const response = await failure(auth.authenticate(fakeRequest({ ...bearer(fakeJwt()), dpop: "" })));
      expect(response.status).toBe(401);
      expect(client.verifyCalls).toHaveLength(0);
    });

    it("refuses a DPoP header on a request without Authorization", async () => {
      const { auth } = setup();
      const response = await failure(auth.authenticate(fakeRequest({ dpop: "proof" })));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("DPoP is not supported");
    });

    it("treats the DPoP scheme as no credential", async () => {
      const { auth, client } = setup();
      const response = await failure(auth.authenticate(fakeRequest({ authorization: `DPoP ${fakeJwt()}` })));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).not.toContain("error=");
      expect(client.verifyCalls).toHaveLength(0);
    });

    it.each([
      ["jkt", { cnf: { jkt: "thumbprint" } }],
      ["x5t#S256", { cnf: { "x5t#S256": "thumbprint" } }],
      ["empty object", { cnf: {} }],
    ])("refuses a token that claims a %s confirmation, before any verification", async (_name, claims) => {
      const { auth, client } = setup({}, { dpopMode: "disabled" });
      const response = await failure(auth.authenticate(fakeRequest(bearer(fakeJwt(claims)))));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("DPoP-bound access tokens are not supported");
      expect(client.verifyCalls).toHaveLength(0);
    });

    it("lets a token with a null cnf claim through to verification", async () => {
      const { auth, client } = setup();
      await auth.authenticate(fakeRequest(bearer(fakeJwt({ cnf: null }))));
      expect(client.verifyCalls).toHaveLength(1);
    });

    it("lets tokens that are not decodable JWTs through to verification", async () => {
      const { auth, client } = setup();
      for (const token of ["opaque", "a.b", "a.e30.c", `a.${Buffer.from("[]").toString("base64url")}.c`]) {
        await auth.authenticate(fakeRequest(bearer(token)));
      }
      expect(client.verifyCalls).toHaveLength(4);
    });
  });

  describe("session binding", () => {
    it("is on when a session id is present and refuses a second subject with 403", async () => {
      let sub = "alice";
      const { auth } = setup({}, { verify: async () => callerFor(principalOf({ sub })) });
      const headers = { ...bearer(fakeJwt()), "mcp-session-id": "s1" };
      await auth.authenticate(fakeRequest(headers));
      sub = "bob";
      const response = await failure(auth.authenticate(fakeRequest(headers)));
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(JSON.parse(await response.text())).toEqual({
        error: "forbidden",
        error_description: "The session belongs to a different caller.",
      });
    });

    it("lets the same subject reuse the session id", async () => {
      const { auth } = setup();
      const headers = { ...bearer(fakeJwt()), "mcp-session-id": "s1" };
      await auth.authenticate(fakeRequest(headers));
      await expect(auth.authenticate(fakeRequest(headers))).resolves.toBeDefined();
    });

    it("does nothing without a session id", async () => {
      let sub = "alice";
      const { auth } = setup({}, { verify: async () => callerFor(principalOf({ sub })) });
      await auth.authenticate(fakeRequest(bearer(fakeJwt())));
      sub = "bob";
      await expect(auth.authenticate(fakeRequest(bearer(fakeJwt())))).resolves.toBeDefined();
    });

    it("can be switched off", async () => {
      let sub = "alice";
      const { auth } = setup({ sessionBinding: false }, { verify: async () => callerFor(principalOf({ sub })) });
      const headers = { ...bearer(fakeJwt()), "mcp-session-id": "s1" };
      await auth.authenticate(fakeRequest(headers));
      sub = "bob";
      await expect(auth.authenticate(fakeRequest(headers))).resolves.toBeDefined();
    });

    it("does not bind a session id for a request that failed authentication", async () => {
      let fail = true;
      let sub = "alice";
      const { auth } = setup(
        {},
        {
          verify: async () => {
            if (fail) throw new VerifyAccessTokenError("bad");
            return callerFor(principalOf({ sub }));
          },
        },
      );
      const headers = { ...bearer(fakeJwt()), "mcp-session-id": "s1" };
      await failure(auth.authenticate(fakeRequest(headers)));
      fail = false;
      sub = "bob";
      await expect(auth.authenticate(fakeRequest(headers))).resolves.toBeDefined();
    });

    it("applies the configured size limit", async () => {
      let sub = "alice";
      const { auth } = setup(
        { sessionBinding: { maxSessions: 1 } },
        { verify: async () => callerFor(principalOf({ sub })) },
      );
      await auth.authenticate(fakeRequest({ ...bearer(fakeJwt()), "mcp-session-id": "s1" }));
      sub = "carol";
      await auth.authenticate(fakeRequest({ ...bearer(fakeJwt()), "mcp-session-id": "s2" }));
      // s1 was evicted by s2, so bob can take it now.
      sub = "bob";
      await expect(
        auth.authenticate(fakeRequest({ ...bearer(fakeJwt()), "mcp-session-id": "s1" })),
      ).resolves.toBeDefined();
    });

    it("refuses an oversized session id with 400", async () => {
      const { auth, client } = setup();
      const response = await failure(
        auth.authenticate(fakeRequest({ ...bearer(fakeJwt()), "mcp-session-id": "x".repeat(257) })),
      );
      expect(response.status).toBe(400);
      expect(client.verifyCalls).toHaveLength(0);
      await expect(
        auth.authenticate(fakeRequest({ ...bearer(fakeJwt()), "mcp-session-id": "x".repeat(256) })),
      ).resolves.toBeDefined();
    });
  });

  describe("oauth", () => {
    it("builds the metadata from the same resource the challenge names", async () => {
      const { auth } = setup();
      expect(auth.oauth.protectedResource.resource).toBe(AUDIENCE);
      const response = await failure(auth.authenticate(fakeRequest()));
      const url = /resource_metadata="([^"]+)"/.exec(response.headers.get("www-authenticate")!)![1]!;
      expect(url).toBe(`https://mcp.example.com/.well-known/oauth-protected-resource${new URL(AUDIENCE).pathname}`);
    });

    it("names the same metadata URL that @auth0/ai-mcp derives from the resource by itself", async () => {
      const audiences = [
        "https://mcp.example.com/mcp",
        "https://mcp.example.com/mcp/",
        "https://mcp.example.com",
        "https://mcp.example.com/",
        "http://127.0.0.1:4000/api/mcp",
      ];
      for (const audience of audiences) {
        const path = new URL(audience).pathname.replace(/\/$/, "");
        const { auth, client } = setup({ ...(path !== "" && { endpoint: path as `/${string}` }) }, { audience });
        const mine = await failure(auth.authenticate(fakeRequest()));
        const theirs = await authenticateRequest(new Request(audience), { client: bearerOnly(client) });
        expect(theirs.ok).toBe(false);
        const challenge = (response: Response) => response.headers.get("www-authenticate");
        expect(challenge(mine)).toBe(challenge((theirs as RejectedRequest).response));
      }
    });

    it("passes the optional metadata fields on", () => {
      const { auth } = setup({
        authorizationServers: ["https://issuer.example.com/"],
        metadata: { scopesSupported: ["a", "b"], resourceName: "Orders", resourceDocumentation: "https://docs.example.com" },
      });
      expect(auth.oauth.protectedResource).toMatchObject({
        authorizationServers: ["https://issuer.example.com/"],
        scopesSupported: ["a", "b"],
        resourceName: "Orders",
        resourceDocumentation: "https://docs.example.com",
      });
    });
  });
});
