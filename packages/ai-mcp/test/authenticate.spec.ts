import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import { authenticateRequest } from "../src/authenticate.js";
import { createMcpClient } from "../src/client.js";
import type { McpClient } from "../src/client.js";
import * as entry from "../src/index.js";
import { getCallerMcpClient, getCallerPrincipal } from "../src/request-context.js";
import { createAuth0Handlers, createTestKey, mintAccessToken } from "./support/index.js";
import type { TestKey } from "./support/index.js";

const AUDIENCE = "https://mcp.example.com/mcp";
const ENDPOINT = "https://mcp.example.com/mcp";
const PRM_SUFFIXED = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
let client: McpClient;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  tenant = createAuth0Handlers({ key });
  server.listen({ onUnhandledRequest: "error" });
  client = createMcpClient({ domain: "tenant.example.com", audience: AUDIENCE, clientId: "c", clientSecret: "s" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function authorized(claims: Parameters<typeof mintAccessToken>[1] = {}) {
  return mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: "user|1",
    scope: "read write",
    claims: { azp: "client-a" },
    ...claims,
  });
}

async function post(token?: string) {
  server.use(...tenant.handlers);
  return new Request(ENDPOINT, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("authenticateRequest", () => {
  it("returns the caller, the auth info and a function that binds the request context", async () => {
    const result = await authenticateRequest(await post(await authorized()), { client });
    if (!result.ok) throw new Error("expected an authenticated request");

    expect(result.scheme).toBe("Bearer");
    expect(result.caller.principal.sub).toBe("user|1");
    expect(result.authInfo).toMatchObject({
      token: "",
      clientId: "client-a",
      scopes: ["read", "write"],
      extra: { sub: "user|1" },
    });
    expect(result.authInfo.resource?.href).toBe(AUDIENCE);
    expect(getCallerPrincipal()).toBeUndefined();

    const seen = await result.run(async () => ({
      principal: getCallerPrincipal(),
      scoped: getCallerMcpClient(),
    }));
    expect(seen.principal).toBe(result.caller.principal);
    expect(seen.scoped).toBe(result.caller.mcpClient);
  });

  it("propagates errors thrown inside run unchanged", async () => {
    const result = await authenticateRequest(await post(await authorized()), { client });
    if (!result.ok) throw new Error("expected an authenticated request");
    const boom = new Error("boom");
    await expect(result.run(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("answers a missing credential with a challenge that has no error value", async () => {
    const result = await authenticateRequest(await post(), { client });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.response.status).toBe(401);
    const challenge = result.response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${PRM_SUFFIXED}"`);
    expect(challenge).not.toContain("error=");
  });

  it("answers an invalid token with 401 and a generic body", async () => {
    const result = await authenticateRequest(await post(await authorized({ exp: Math.floor(Date.now() / 1000) - 60 })), {
      client,
    });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await result.response.json()).toEqual({
      error: "invalid_token",
      error_description: "The access token is invalid or has expired.",
    });
  });

  it("answers a missing server-wide scope with 403 naming only the missing scope", async () => {
    const result = await authenticateRequest(await post(await authorized()), {
      client,
      requiredScopes: ["read", "admin"],
    });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get("www-authenticate")).toContain('scope="admin"');
  });

  it("uses an explicit metadata URL and realm in the challenge", async () => {
    const result = await authenticateRequest(await post(), {
      client,
      realm: "mcp",
      resourceMetadataUrl: "https://mcp.example.com/prm.json",
    });
    if (result.ok) throw new Error("expected a rejection");
    const challenge = result.response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('realm="mcp"');
    expect(challenge).toContain('resource_metadata="https://mcp.example.com/prm.json"');
  });

  it("reports a 500 failure to onError and keeps the response generic", async () => {
    const seen: unknown[] = [];
    const broken = {
      ...client,
      dpopMode: "allowed" as const,
      verifyAccessToken: () => Promise.reject(new Error("internal detail")),
    } as McpClient;
    const result = await authenticateRequest(await post("abc"), { client: broken, onError: (e) => seen.push(e) });
    if (result.ok) throw new Error("expected a rejection");
    expect(result.response.status).toBe(500);
    expect(JSON.stringify(await result.response.json())).not.toContain("internal detail");
    expect(seen).toHaveLength(1);
  });

  it("throws for invalid configuration rather than answering a request", async () => {
    await expect(authenticateRequest(await post(), { client, resource: "https://other.example.com/mcp" })).rejects.toThrow(
      InvalidConfigurationError,
    );
    await expect(authenticateRequest(await post(), { client, realm: 'bad"realm' })).rejects.toThrow(
      InvalidConfigurationError,
    );
  });
});

describe("public helpers on the package entry", () => {
  it("exports authenticateRequest, buildWwwAuthenticate and buildProtectedResourceMetadata", () => {
    expect(entry.authenticateRequest).toBe(authenticateRequest);
    expect(typeof entry.buildWwwAuthenticate).toBe("function");
    expect(typeof entry.buildProtectedResourceMetadata).toBe("function");
  });

  it("builds a challenge from documented options", () => {
    expect(
      entry.buildWwwAuthenticate({
        schemes: ["Bearer"],
        error: "invalid_token",
        errorDescription: "The access token is invalid.",
        resourceMetadata: PRM_SUFFIXED,
      }),
    ).toEqual([`Bearer error="invalid_token", error_description="The access token is invalid.", resource_metadata="${PRM_SUFFIXED}"`]);
  });

  it("builds the metadata document with the defaults from the client", () => {
    expect(entry.buildProtectedResourceMetadata({ client, scopesSupported: ["read"], resourceName: "Example" })).toEqual({
      resource: AUDIENCE,
      authorization_servers: ["https://tenant.example.com/"],
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: ["ES256"],
      scopes_supported: ["read"],
      resource_name: "Example",
    });
  });

  it("follows the DPoP mode of the client in the metadata document", () => {
    const required = createMcpClient({
      domain: "tenant.example.com",
      audience: AUDIENCE,
      dpop: { mode: "required" },
    });
    expect(entry.buildProtectedResourceMetadata({ client: required })).toMatchObject({
      dpop_bound_access_tokens_required: true,
    });
  });

  it("rejects a resource that differs from the client audience", () => {
    expect(() => entry.buildProtectedResourceMetadata({ client, resource: "https://other.example.com/mcp" })).toThrow(
      InvalidConfigurationError,
    );
  });
});
