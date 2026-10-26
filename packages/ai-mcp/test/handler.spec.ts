import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { setupServer } from "msw/node";
import {
  AuthError,
  InvalidConfigurationError,
  InvalidDpopProofError,
  InvalidRequestError,
  VerifyAccessTokenError,
} from "@auth0/auth0-api-js";
import { createMcpClient, ForeignCallerError } from "../src/client.js";
import type { McpClient } from "../src/client.js";
import {
  DownscopedTokenError,
  InsufficientScopeError,
  UnauthenticatedError,
} from "../src/errors.js";
import { createMcpHandler } from "../src/handler.js";
import type { AuthInfo, McpHandlerOptions } from "../src/handler.js";
import {
  getCallerMcpClient,
  getCallerPrincipal,
  getRequestContext,
} from "../src/request-context.js";
import type { Principal, RequestScopedMcpClient } from "../src/types.js";
import {
  createAuth0Handlers,
  createTestKey,
  mintAccessToken,
  scopeMode,
} from "./support/index.js";
import type { TestKey } from "./support/index.js";

const AUDIENCE = "https://mcp.example.com";
const ENDPOINT = "https://mcp.example.com/mcp";
const PRM = "https://mcp.example.com/.well-known/oauth-protected-resource";

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  tenant = createAuth0Handlers({ key, scope: scopeMode.echo });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function useTenant() {
  server.use(...tenant.handlers);
}

type ClientOverrides = Partial<Parameters<typeof createMcpClient>[0]>;

function makeClient(overrides: ClientOverrides = {}): McpClient {
  return createMcpClient({
    domain: "tenant.example.com",
    audience: AUDIENCE,
    clientId: "mcp-client",
    clientSecret: "secret",
    ...overrides,
  });
}

function token(
  claims: Record<string, unknown> = {},
  extra: Parameters<typeof mintAccessToken>[1] = {},
) {
  return mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: "user|1",
    scope: "read write",
    claims: { client_id: "client-a", ...claims },
    ...extra,
  });
}

interface Harness {
  handle: (request: Request) => Promise<Response>;
  calls: Array<{ request: Request; authInfo: AuthInfo }>;
}

function makeHandler(
  options: Partial<McpHandlerOptions> = {},
  downstream?: (request: Request, authInfo: AuthInfo) => Promise<Response>,
  client: McpClient = makeClient(),
): Harness {
  const calls: Harness["calls"] = [];
  const handle = createMcpHandler({
    client,
    resource: AUDIENCE,
    authorizationServers: [tenant.issuer],
    handler: async (request, authInfo) => {
      calls.push({ request, authInfo });
      return downstream
        ? downstream(request, authInfo)
        : new Response("ok", { status: 200 });
    },
    ...options,
  });
  return { handle, calls };
}

function request(
  headers: Record<string, string> = {},
  init: RequestInit = {},
  url = ENDPOINT,
) {
  return new Request(url, { method: "POST", ...init, headers });
}

async function bearer(
  claims: Record<string, unknown> = {},
  extra: Parameters<typeof mintAccessToken>[1] = {},
) {
  return { authorization: `Bearer ${await token(claims, extra)}` };
}

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function wwwAuthenticate(response: Response): string | null {
  return response.headers.get("www-authenticate");
}

const ALLOWED_PRM = `resource_metadata="${PRM}"`;
const BEARER_ADVERT = `Bearer ${ALLOWED_PRM}`;
const DPOP_ADVERT = `DPoP algs="ES256", ${ALLOWED_PRM}`;
const GENERIC = {
  invalid_token: "The access token is invalid or has expired.",
  invalid_request: "The request is malformed.",
  insufficient_scope: "The access token does not include the required scope.",
  invalid_dpop_proof: "The DPoP proof is invalid.",
};

function bearerError(code: keyof typeof GENERIC) {
  return `Bearer error="${code}", error_description="${GENERIC[code]}", ${ALLOWED_PRM}`;
}
function dpopError(code: keyof typeof GENERIC) {
  return `DPoP error="${code}", error_description="${GENERIC[code]}", algs="ES256", ${ALLOWED_PRM}`;
}

async function dpopMaterial(
  accessTokenFor: (jkt: string) => Promise<string>,
  url = ENDPOINT,
  method = "POST",
) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  const accessToken = await accessTokenFor(jkt);
  const proof = await new SignJWT({
    htm: method,
    htu: url,
    ath: createHash("sha256").update(accessToken).digest("base64url"),
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .setIssuedAt()
    .sign(privateKey);
  return { accessToken, proof };
}

const dpopToken = (jkt: string, claims: Record<string, unknown> = {}) =>
  token({ cnf: { jkt }, ...claims });

describe("failure responses", () => {
  interface FailureCase {
    name: string;
    headers: () => Promise<Record<string, string>>;
    status: number;
    challenge: string;
    body: { error: string; error_description: string };
    client?: ClientOverrides;
  }

  const invalidToken = {
    error: "invalid_token",
    error_description: GENERIC.invalid_token,
  };
  const unauthorized = {
    error: "unauthorized",
    error_description: "Authentication is required.",
  };
  const malformed = {
    error: "invalid_request",
    error_description: GENERIC.invalid_request,
  };

  const cases: FailureCase[] = [
    {
      name: "missing credential: no error parameter on any challenge",
      headers: async () => ({}),
      status: 401,
      challenge: `${BEARER_ADVERT}, ${DPOP_ADVERT}`,
      body: {
        error: "unauthorized",
        error_description: "Authentication is required.",
      },
    },
    {
      name: "unknown scheme counts as no credential",
      headers: async () => ({ authorization: "Basic dXNlcjpwYXNz" }),
      status: 401,
      challenge: `${BEARER_ADVERT}, ${DPOP_ADVERT}`,
      body: unauthorized,
    },
    {
      name: "multiple tokens",
      headers: async () => ({ authorization: "Bearer abc def" }),
      status: 400,
      challenge: `${bearerError("invalid_request")}, ${DPOP_ADVERT}`,
      body: malformed,
    },
    {
      name: "scheme with no token",
      headers: async () => ({ authorization: "Bearer" }),
      status: 400,
      challenge: `${bearerError("invalid_request")}, ${DPOP_ADVERT}`,
      body: malformed,
    },
    {
      name: "empty Authorization header counts as no credential",
      headers: async () => ({ authorization: "" }),
      status: 401,
      challenge: `${BEARER_ADVERT}, ${DPOP_ADVERT}`,
      body: unauthorized,
    },
    {
      name: "Bearer token over the length cap",
      headers: async () => ({ authorization: `Bearer ${"a".repeat(8193)}` }),
      status: 400,
      challenge: `${bearerError("invalid_request")}, ${DPOP_ADVERT}`,
      body: malformed,
    },
    {
      name: "DPoP token over the length cap",
      headers: async () => ({
        authorization: `DPoP ${"a".repeat(8193)}`,
        dpop: "a.b.c",
      }),
      status: 400,
      challenge: `${BEARER_ADVERT}, ${dpopError("invalid_request")}`,
      body: malformed,
    },
    {
      name: "DPoP proof over the length cap",
      headers: async () => ({
        authorization: "DPoP abc.def.ghi",
        dpop: `a.b.${"c".repeat(8192)}`,
      }),
      status: 400,
      challenge: `${BEARER_ADVERT}, ${dpopError("invalid_request")}`,
      body: malformed,
    },
    {
      name: "token with characters outside the token68 set",
      headers: async () => ({ authorization: 'Bearer ab"c' }),
      status: 400,
      challenge: `${bearerError("invalid_request")}, ${DPOP_ADVERT}`,
      body: malformed,
    },
    {
      name: "DPoP scheme without a proof header: error lands on the DPoP challenge",
      headers: async () => ({ authorization: "DPoP abc.def.ghi" }),
      status: 400,
      challenge: `${BEARER_ADVERT}, ${dpopError("invalid_request")}`,
      body: malformed,
    },
    {
      name: "DPoP scheme with a proof that is not a JWS",
      headers: async () => ({
        authorization: "DPoP abc.def.ghi",
        dpop: "not-a-jwt",
      }),
      status: 400,
      challenge: `${BEARER_ADVERT}, ${dpopError("invalid_request")}`,
      body: malformed,
    },
    {
      name: "DPoP scheme with several tokens",
      headers: async () => ({
        authorization: "DPoP abc.def.ghi extra",
        dpop: "a.b.c",
      }),
      status: 400,
      challenge: `${BEARER_ADVERT}, ${dpopError("invalid_request")}`,
      body: malformed,
    },
    {
      name: "token that is not a JWT",
      headers: async () => ({ authorization: "Bearer not-a-jwt" }),
      status: 401,
      challenge: `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
      body: invalidToken,
    },
    {
      name: "wrong audience",
      headers: async () => bearer({}, { aud: "https://other.example.com" }),
      status: 401,
      challenge: `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
      body: invalidToken,
    },
    {
      name: "expired token",
      headers: async () =>
        bearer({}, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      status: 401,
      challenge: `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
      body: invalidToken,
    },
    {
      name: "signature from an unknown key",
      headers: async () => {
        const other = await createTestKey({ kid: "other-key" });
        return {
          authorization: `Bearer ${await mintAccessToken(other, { iss: tenant.issuer, aud: AUDIENCE, sub: "u" })}`,
        };
      },
      status: 401,
      challenge: `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
      body: invalidToken,
    },
    {
      name: "DPoP-bound token presented as Bearer",
      headers: async () => {
        const { accessToken } = await dpopMaterial((jkt) => dpopToken(jkt));
        return { authorization: `Bearer ${accessToken}` };
      },
      status: 401,
      challenge: `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
      body: invalidToken,
    },
    {
      name: "DPoP proof bound to another URL",
      headers: async () => {
        const { accessToken, proof } = await dpopMaterial(
          (jkt) => dpopToken(jkt),
          "https://mcp.example.com/other",
        );
        return { authorization: `DPoP ${accessToken}`, dpop: proof };
      },
      status: 401,
      challenge: `${BEARER_ADVERT}, ${dpopError("invalid_dpop_proof")}`,
      body: {
        error: "invalid_dpop_proof",
        error_description: GENERIC.invalid_dpop_proof,
      },
    },
    {
      name: "organization not allowed collapses to invalid_token",
      headers: async () => bearer({ org_id: "org_other" }),
      status: 401,
      challenge: `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
      body: invalidToken,
      client: { organizationPolicy: "required", organizationId: "org_allowed" },
    },
    {
      name: "organization missing collapses to invalid_token",
      headers: async () => bearer(),
      status: 401,
      challenge: `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
      body: invalidToken,
      client: { organizationPolicy: "required" },
    },
  ];

  it.each(cases)(
    "$name",
    async ({ headers, status, challenge, body, client }) => {
      useTenant();
      const { handle, calls } = makeHandler({}, undefined, makeClient(client));
      const response = await handle(request(await headers()));
      expect(response.status).toBe(status);
      expect(wwwAuthenticate(response)).toBe(challenge);
      expect(await bodyOf(response)).toEqual(body);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(calls).toHaveLength(0);
    },
  );

  it("answers a missing credential with a header that has no error parameter at all", async () => {
    const { handle } = makeHandler();
    const challenge = wwwAuthenticate(await handle(request())) ?? "";
    expect(challenge).not.toMatch(/error/);
  });

  it("matches the scheme name case-insensitively", async () => {
    useTenant();
    const { handle } = makeHandler();
    const t = await token();
    expect(
      (await handle(request({ authorization: `bEaReR ${t}` }))).status,
    ).toBe(200);
  });

  it("accepts more than one space between scheme and token", async () => {
    useTenant();
    const { handle } = makeHandler();
    const t = await token();
    expect(
      (await handle(request({ authorization: `Bearer   ${t}` }))).status,
    ).toBe(200);
  });

  it("never repeats verifier messages in the response", async () => {
    useTenant();
    const { handle } = makeHandler();
    const response = await handle(
      request(await bearer({}, { aud: "https://other.example.com" })),
    );
    const everything = `${wwwAuthenticate(response)}${JSON.stringify(await bodyOf(response))}`;
    expect(everything).not.toMatch(/aud|claim|JWT|unexpected/i);
  });
});

describe("realm", () => {
  it("is included in every challenge when configured", async () => {
    const { handle } = makeHandler({ realm: "my mcp" });
    const response = await handle(request());
    expect(wwwAuthenticate(response)).toBe(
      `Bearer realm="my mcp", ${ALLOWED_PRM}, DPoP realm="my mcp", algs="ES256", ${ALLOWED_PRM}`,
    );
  });

  it("is absent when not configured", async () => {
    const { handle } = makeHandler();
    expect(wwwAuthenticate(await handle(request()))).not.toContain("realm");
  });
});

describe("DPoP modes", () => {
  it("required: advertises only DPoP and rejects a Bearer credential", async () => {
    useTenant();
    const client = makeClient({ dpop: { mode: "required" } });
    const { handle, calls } = makeHandler({}, undefined, client);
    const missing = await handle(request());
    expect(missing.status).toBe(401);
    expect(wwwAuthenticate(missing)).toBe(DPOP_ADVERT);
    const rejected = await handle(request(await bearer()));
    expect(rejected.status).toBe(401);
    expect(wwwAuthenticate(rejected)).toBe(DPOP_ADVERT);
    expect(wwwAuthenticate(rejected)).not.toContain("error");
    expect(await bodyOf(rejected)).toEqual({
      error: "unauthorized",
      error_description: "Authentication is required.",
    });
    expect(calls).toHaveLength(0);
  });

  it("required: accepts a valid DPoP request", async () => {
    useTenant();
    const client = makeClient({ dpop: { mode: "required" } });
    const { handle, calls } = makeHandler({}, undefined, client);
    const { accessToken, proof } = await dpopMaterial((jkt) => dpopToken(jkt));
    const response = await handle(
      request({ authorization: `DPoP ${accessToken}`, dpop: proof }),
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.authInfo.token).toBe('');
  });

  it("allowed: accepts a DPoP request and a Bearer request", async () => {
    useTenant();
    const { handle, calls } = makeHandler();
    const { accessToken, proof } = await dpopMaterial((jkt) => dpopToken(jkt));
    expect(
      (
        await handle(
          request({ authorization: `DPoP ${accessToken}`, dpop: proof }),
        )
      ).status,
    ).toBe(200);
    expect((await handle(request(await bearer()))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("disabled: advertises only Bearer", async () => {
    useTenant();
    const client = makeClient({ dpop: { mode: "disabled" } });
    const { handle, calls } = makeHandler({}, undefined, client);
    expect(wwwAuthenticate(await handle(request()))).toBe(BEARER_ADVERT);
    const { accessToken, proof } = await dpopMaterial((jkt) => dpopToken(jkt));
    const rejected = await handle(
      request({ authorization: `DPoP ${accessToken}`, dpop: proof }),
    );
    expect(rejected.status).toBe(401);
    expect(wwwAuthenticate(rejected)).toBe(BEARER_ADVERT);
    expect(calls).toHaveLength(0);
  });

  it("derives the mode from the client, not from a handler option", async () => {
    const strict = makeHandler(
      {},
      undefined,
      makeClient({ dpop: { mode: "required" } }),
    );
    expect(wwwAuthenticate(await strict.handle(request()))).toBe(DPOP_ADVERT);
    const off = makeHandler(
      {},
      undefined,
      makeClient({ dpop: { mode: "disabled" } }),
    );
    expect(wwwAuthenticate(await off.handle(request()))).toBe(BEARER_ADVERT);
  });

  it("declares the mode in the metadata document", async () => {
    const required = makeHandler(
      {},
      undefined,
      makeClient({ dpop: { mode: "required" } }),
    );
    expect(
      await bodyOf(await required.handle(request({}, { method: "GET" }, PRM))),
    ).toMatchObject({
      dpop_bound_access_tokens_required: true,
    });
  });
});

describe("server-wide required scopes", () => {
  it("lists only the missing scopes in a 403 and skips the downstream handler", async () => {
    useTenant();
    const { handle, calls } = makeHandler({
      requiredScopes: ["read", "admin", "audit"],
    });
    const response = await handle(request(await bearer()));
    expect(response.status).toBe(403);
    expect(wwwAuthenticate(response)).toBe(
      `Bearer error="insufficient_scope", error_description="${GENERIC.insufficient_scope}", scope="admin audit", ${ALLOWED_PRM}, ${DPOP_ADVERT}`,
    );
    expect(await bodyOf(response)).toEqual({
      error: "insufficient_scope",
      error_description: GENERIC.insufficient_scope,
    });
    expect(calls).toHaveLength(0);
  });

  it("requires all scopes (AND semantics)", async () => {
    useTenant();
    const { handle } = makeHandler({ requiredScopes: ["read", "write"] });
    expect(
      (await handle(request(await bearer({}, { scope: "read" })))).status,
    ).toBe(403);
    expect(
      (await handle(request(await bearer({}, { scope: "write read extra" }))))
        .status,
    ).toBe(200);
  });

  it("lists every required scope when the token has no scope claim", async () => {
    useTenant();
    const { handle } = makeHandler({ requiredScopes: ["a", "b"] });
    const response = await handle(
      request(await bearer({}, { scope: undefined })),
    );
    expect(wwwAuthenticate(response)).toContain('scope="a b"');
  });

  it("reads the scope claim only, not permissions", async () => {
    useTenant();
    const { handle, calls } = makeHandler({ requiredScopes: ["a"] });
    const response = await handle(
      request(await bearer({ permissions: ["a"] }, { scope: "other" })),
    );
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("lists a duplicated requirement once", async () => {
    useTenant();
    const { handle } = makeHandler({ requiredScopes: ["a", "a"] });
    const response = await handle(request(await bearer({}, { scope: "x" })));
    expect(wwwAuthenticate(response)).toContain('scope="a"');
  });

  it("puts the error on the DPoP challenge for a DPoP request", async () => {
    useTenant();
    const { handle } = makeHandler({ requiredScopes: ["admin"] });
    const { accessToken, proof } = await dpopMaterial((jkt) => dpopToken(jkt));
    const response = await handle(
      request({ authorization: `DPoP ${accessToken}`, dpop: proof }),
    );
    expect(response.status).toBe(403);
    expect(wwwAuthenticate(response)).toBe(
      `${BEARER_ADVERT}, DPoP error="insufficient_scope", error_description="${GENERIC.insufficient_scope}", scope="admin", algs="ES256", ${ALLOWED_PRM}`,
    );
  });

  it("does not run the gate before the credential is verified", async () => {
    useTenant();
    const { handle } = makeHandler({ requiredScopes: ["admin"] });
    expect(
      (await handle(request({ authorization: "Bearer not-a-jwt" }))).status,
    ).toBe(401);
  });
});

describe("AuthInfo", () => {
  it("describes the caller", async () => {
    useTenant();
    const { handle, calls } = makeHandler();
    const exp = Math.floor(Date.now() / 1000) + 1200;
    const headers = await bearer({}, { exp });
    const response = await handle(request(headers));
    expect(response.status).toBe(200);
    const info = calls[0]?.authInfo;
    expect(info).toEqual({
      token: '',
      clientId: "client-a",
      scopes: ["read", "write"],
      expiresAt: exp,
      resource: new URL(AUDIENCE),
      extra: { sub: "user|1" },
    });
  });

  it("adds organization and permissions when the token carries them", async () => {
    useTenant();
    const { handle, calls } = makeHandler();
    await handle(
      request(await bearer({ org_id: "org_1", permissions: ["p:a"] })),
    );
    expect(calls[0]?.authInfo.extra).toEqual({
      sub: "user|1",
      orgId: "org_1",
      permissions: ["p:a"],
    });
  });

  it("uses an empty client id when the token names none", async () => {
    useTenant();
    const { handle, calls } = makeHandler();
    await handle(request(await bearer({ client_id: undefined })));
    expect(calls[0]?.authInfo.clientId).toBe("");
  });

  it("passes the original request to the downstream handler", async () => {
    useTenant();
    const { handle, calls } = makeHandler();
    const incoming = request(await bearer(), { body: "payload" });
    await handle(incoming);
    expect(calls[0]?.request).toBe(incoming);
  });

  it("returns the downstream response unchanged", async () => {
    useTenant();
    const { handle } = makeHandler(
      {},
      async () =>
        new Response("created", { status: 201, headers: { "x-a": "b" } }),
    );
    const response = await handle(request(await bearer()));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-a")).toBe("b");
    expect(await response.text()).toBe("created");
  });
});

describe("request context", () => {
  it("is visible inside the downstream handler, including after await, and gone afterwards", async () => {
    useTenant();
    let seen: {
      principal?: Principal;
      client?: RequestScopedMcpClient;
      later?: string;
    } = {};
    const { handle } = makeHandler({}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen = {
        principal: getCallerPrincipal(),
        client: getCallerMcpClient(),
        later: getRequestContext()?.principal.sub,
      };
      return new Response("ok");
    });
    expect(getRequestContext()).toBeUndefined();
    await handle(request(await bearer({}, { sub: "user|ctx" })));
    expect(seen.principal?.sub).toBe("user|ctx");
    expect(seen.client?.getPrincipal().sub).toBe("user|ctx");
    expect(seen.later).toBe("user|ctx");
    expect(getRequestContext()).toBeUndefined();
    expect(getCallerPrincipal()).toBeUndefined();
  });

  it("keeps concurrent requests apart", async () => {
    useTenant();
    const seen: string[] = [];
    const { handle } = makeHandler({}, async (_req, info) => {
      await new Promise((resolve) =>
        setTimeout(resolve, info.extra?.["sub"] === "user|slow" ? 20 : 1),
      );
      seen.push(`${info.extra?.["sub"]}=${getCallerPrincipal()?.sub}`);
      return new Response("ok");
    });
    await Promise.all([
      handle(request(await bearer({}, { sub: "user|slow" }))),
      handle(request(await bearer({}, { sub: "user|fast" }))),
    ]);
    expect(seen.sort()).toEqual(["user|fast=user|fast", "user|slow=user|slow"]);
  });

  it("is not set for rejected requests", async () => {
    useTenant();
    let observed: Principal | undefined;
    const { handle } = makeHandler({ requiredScopes: ["admin"] }, async () => {
      observed = getCallerPrincipal();
      return new Response("ok");
    });
    await handle(request(await bearer()));
    expect(observed).toBeUndefined();
  });
});

describe("protected resource metadata route", () => {
  it("serves the document without authentication", async () => {
    const { handle, calls } = makeHandler({
      metadata: {
        scopesSupported: ["read"],
        resourceName: "Example MCP",
        resourceDocumentation: "https://docs.example.com",
      },
    });
    const response = await handle(request({}, { method: "GET" }, PRM));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await bodyOf(response)).toEqual({
      resource: AUDIENCE,
      authorization_servers: [tenant.issuer],
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: ["ES256"],
      scopes_supported: ["read"],
      resource_name: "Example MCP",
      resource_documentation: "https://docs.example.com",
    });
    expect(calls).toHaveLength(0);
  });

  it("declares DPoP binding when DPoP is required and no DPoP support when disabled", async () => {
    const required = await makeHandler(
      {},
      undefined,
      makeClient({ dpop: { mode: "required" } }),
    ).handle(request({}, { method: "GET" }, PRM));
    expect(await bodyOf(required)).toMatchObject({
      dpop_bound_access_tokens_required: true,
    });
    const disabled = await makeHandler(
      {},
      undefined,
      makeClient({ dpop: { mode: "disabled" } }),
    ).handle(request({}, { method: "GET" }, PRM));
    const body = await bodyOf(disabled);
    expect(body).not.toHaveProperty("dpop_signing_alg_values_supported");
    expect(body).not.toHaveProperty("dpop_bound_access_tokens_required");
  });

  it("rejects other methods with 405", async () => {
    const { handle } = makeHandler();
    const response = await handle(request({}, { method: "POST" }, PRM));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("inserts the resource path after the well-known prefix", async () => {
    const { handle } = makeHandler({
      resource: "https://mcp.example.com/mcp/",
    });
    const url =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const served = await handle(request({}, { method: "GET" }, url));
    expect(served.status).toBe(200);
    expect((await bodyOf(served))["resource"]).toBe(
      "https://mcp.example.com/mcp/",
    );
    expect(wwwAuthenticate(await handle(request()))).toContain(
      `resource_metadata="${url}"`,
    );
  });

  it("serves a custom path and points the challenge at it", async () => {
    const { handle, calls } = makeHandler({ metadata: { path: "/prm.json" } });
    expect(wwwAuthenticate(await handle(request()))).toContain(
      'resource_metadata="https://mcp.example.com/prm.json"',
    );
    expect(
      (
        await handle(
          request({}, { method: "GET" }, "https://mcp.example.com/prm.json"),
        )
      ).status,
    ).toBe(200);
    expect((await handle(request({}, { method: "GET" }, PRM))).status).toBe(
      401,
    );
    expect(calls).toHaveLength(0);
  });

  it("serves the same document the challenge URL names", async () => {
    const { handle } = makeHandler();
    const challenge = wwwAuthenticate(await handle(request())) ?? "";
    const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
    expect(url).toBe(PRM);
    expect((await handle(request({}, { method: "GET" }, url))).status).toBe(
      200,
    );
  });

  it("ignores the query string when matching the route", async () => {
    const { handle } = makeHandler();
    expect(
      (await handle(request({}, { method: "GET" }, `${PRM}?x=1`))).status,
    ).toBe(200);
  });
});

describe("error mapping", () => {
  async function run(
    error: unknown,
    options: Partial<McpHandlerOptions> = {},
    claims = {},
  ) {
    useTenant();
    const { handle } = makeHandler(options, async () => {
      throw error;
    });
    return handle(request(await bearer(claims)));
  }

  it("maps InsufficientScopeError to 403 listing the scopes the caller lacks", async () => {
    const response = await run(new InsufficientScopeError(["read", "admin"]));
    expect(response.status).toBe(403);
    expect(wwwAuthenticate(response)).toContain('error="insufficient_scope"');
    expect(wwwAuthenticate(response)).toContain('scope="admin"');
    expect(wwwAuthenticate(response)).not.toContain("read");
  });

  it("maps DownscopedTokenError to 403 without scope data", async () => {
    const response = await run(
      new DownscopedTokenError("granted: secret:scope"),
    );
    expect(response.status).toBe(403);
    expect(wwwAuthenticate(response)).toBe(
      `Bearer error="insufficient_scope", error_description="${GENERIC.insufficient_scope}", ${ALLOWED_PRM}, ${DPOP_ADVERT}`,
    );
    expect(JSON.stringify(await bodyOf(response))).not.toContain("secret");
  });

  it("maps UnauthenticatedError to 401 invalid_token", async () => {
    const response = await run(
      new UnauthenticatedError("No authenticated request context."),
    );
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).toBe(
      `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
    );
    expect(JSON.stringify(await bodyOf(response))).not.toContain("context");
  });

  it("answers 500 for a core auth error thrown downstream, such as a failed token exchange", async () => {
    const onError = vi.fn();
    for (const status of [400, 401, 403]) {
      const response = await run(
        new AuthError("exchange failed", "token_exchange_error", status),
        { onError },
      );
      expect(response.status).toBe(500);
      expect(wwwAuthenticate(response)).toBeNull();
    }
    for (const error of [
      new VerifyAccessTokenError("late"),
      new InvalidRequestError("late"),
      new InvalidDpopProofError("late"),
    ]) {
      expect((await run(error, { onError })).status).toBe(500);
    }
    expect(onError).toHaveBeenCalledTimes(6);
  });

  it("does not forward a DPoP nonce from a downstream error", async () => {
    const error = new VerifyAccessTokenError("x", { "dpop-nonce": "n1" });
    expect((await run(error)).headers.get("dpop-nonce")).toBeNull();
  });

  it.each([
    ["a plain error", new Error("database password is hunter2")],
    ["an auth error without a status", new AuthError("hunter2", "custom")],
    [
      "an auth error with a server status",
      new AuthError("hunter2", "custom", 502),
    ],
    ["a thrown string", "hunter2"],
  ])(
    "answers 500 with a generic body and no challenge for %s",
    async (_name, error) => {
      const onError = vi.fn();
      const response = await run(error, { onError });
      expect(response.status).toBe(500);
      expect(wwwAuthenticate(response)).toBeNull();
      expect(await bodyOf(response)).toEqual({
        error: "server_error",
        error_description: "Internal server error.",
      });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(error);
    },
  );

  it("does not call onError for authentication failures", async () => {
    const onError = vi.fn();
    const response = await run(new UnauthenticatedError(), { onError });
    expect(response.status).toBe(401);
    expect(onError).not.toHaveBeenCalled();
  });

  it("still answers 500 when the onError hook throws", async () => {
    const response = await run(new Error("boom"), {
      onError: () => {
        throw new Error("hook failed");
      },
    });
    expect(response.status).toBe(500);
  });
});

describe("request-scoped client failures", () => {
  const principal: Principal = {
    sub: "user|1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    scopes: [],
    permissions: null,
    clientId: null,
    orgId: null,
  };

  function fakeClient(withToken: McpClient["withToken"]): McpClient {
    return {
      dpopMode: "allowed",
      verifyAccessToken: async () => ({ principal }),
      withToken,
    };
  }

  it("answers 500 for a handle that belongs to another client", async () => {
    const onError = vi.fn();
    const client = fakeClient(() => {
      throw new Error("Caller was not verified by this client.");
    });
    const { handle, calls } = makeHandler({ onError }, undefined, client);
    const response = await handle(
      request({ authorization: "Bearer abc.def.ghi" }),
    );
    expect(response.status).toBe(500);
    expect(wwwAuthenticate(response)).toBeNull();
    expect(JSON.stringify(await bodyOf(response))).not.toContain("verified");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("answers 500 when a real client rejects a handle issued by a different client", async () => {
    useTenant();
    const issuer = makeClient();
    const other = makeClient();
    const onError = vi.fn();
    const client: McpClient = {
      dpopMode: "allowed",
      verifyAccessToken: (o) => issuer.verifyAccessToken(o),
      withToken: (c) => other.withToken(c),
    };
    const { handle, calls } = makeHandler({ onError }, undefined, client);
    const response = await handle(request(await bearer()));
    expect(response.status).toBe(500);
    expect(wwwAuthenticate(response)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ForeignCallerError);
    expect(calls).toHaveLength(0);
  });

  it("answers 401 invalid_token for an expired handle", async () => {
    const client = fakeClient(() => {
      throw new UnauthenticatedError("Access token has expired.");
    });
    const { handle } = makeHandler({}, undefined, client);
    const response = await handle(
      request({ authorization: "Bearer abc.def.ghi" }),
    );
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).toBe(
      `${bearerError("invalid_token")}, ${DPOP_ADVERT}`,
    );
  });

  it("answers 500 when verification fails with a non-auth error", async () => {
    const client: McpClient = {
      dpopMode: "allowed",
      verifyAccessToken: async () => {
        throw new TypeError("bad state");
      },
      withToken: () => {
        throw new Error("unreachable");
      },
    };
    const { handle } = makeHandler({}, undefined, client);
    expect(
      (await handle(request({ authorization: "Bearer abc.def.ghi" }))).status,
    ).toBe(500);
  });
});

describe("authentication-phase core errors", () => {
  function failingClient(error: unknown): McpClient {
    return {
      dpopMode: "allowed",
      verifyAccessToken: async () => {
        throw error;
      },
      withToken: () => {
        throw new Error("unreachable");
      },
    };
  }

  async function failWith(
    error: unknown,
    options: Partial<McpHandlerOptions> = {},
  ) {
    const { handle } = makeHandler(options, undefined, failingClient(error));
    return handle(request({ authorization: "Bearer abc.def.ghi" }));
  }

  it("replaces the challenge a core error carries and forwards a clean DPoP nonce", async () => {
    const raw = new VerifyAccessTokenError("raw verifier detail", {
      "www-authenticate": 'Bearer error_description="raw verifier detail"',
      "DPoP-Nonce": "nonce-1",
      "x-internal": "nope",
    });
    const response = await failWith(raw);
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).not.toContain("raw verifier detail");
    expect(wwwAuthenticate(response)).toContain('error="invalid_token"');
    expect(response.headers.get("dpop-nonce")).toBe("nonce-1");
    expect(response.headers.get("x-internal")).toBeNull();
  });

  it("forwards a nonce carried in an array", async () => {
    const withArray = Object.assign(new InvalidRequestError("x"), {
      headers: { "dpop-nonce": ["n1"] },
    });
    expect((await failWith(withArray)).headers.get("dpop-nonce")).toBe("n1");
  });

  it.each([
    ["CR/LF", "abc\r\nSet-Cookie: a=b"],
    ["a quote", 'ab"c'],
    ["a backslash", "ab\\c"],
    ["a space", "ab c"],
    ["a non-ASCII character", "abé"],
    ["an empty value", ""],
    ["a value over 256 characters", "a".repeat(257)],
  ])(
    "drops a nonce containing %s and still answers normally",
    async (_name, nonce) => {
      const response = await failWith(
        new VerifyAccessTokenError("x", { "dpop-nonce": nonce }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("dpop-nonce")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(wwwAuthenticate(response)).toContain('error="invalid_token"');
    },
  );

  it("accepts a nonce of exactly 256 allowed characters", async () => {
    const nonce = "a".repeat(256);
    const response = await failWith(
      new VerifyAccessTokenError("x", { "dpop-nonce": nonce }),
    );
    expect(response.headers.get("dpop-nonce")).toBe(nonce);
  });

  it("drops non-string nonce values", async () => {
    const error = Object.assign(new VerifyAccessTokenError("x"), {
      headers: { "dpop-nonce": [42, "ok"] as unknown as string[] },
    });
    expect((await failWith(error)).headers.get("dpop-nonce")).toBe("ok");
  });

  it("answers a generic 500 when building the error response itself throws", async () => {
    const onError = vi.fn();
    const error = new VerifyAccessTokenError("x");
    Object.defineProperty(error, "headers", {
      get() {
        throw new Error("hostile getter");
      },
    });
    const response = await failWith(error, { onError });
    expect(response.status).toBe(500);
    expect(wwwAuthenticate(response)).toBeNull();
    expect(await bodyOf(response)).toEqual({
      error: "server_error",
      error_description: "Internal server error.",
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(error);
  });

  it("maps an invalid DPoP proof to 401", async () => {
    const response = await failWith(new InvalidDpopProofError("detail"));
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).toContain(
      'DPoP error="invalid_dpop_proof"',
    );
  });

  it("maps a nonce-required error to 401 use_dpop_nonce with the nonce", async () => {
    const error = new AuthError("detail", "use_dpop_nonce", 401, {
      "DPoP-Nonce": "fresh-1",
    });
    const response = await failWith(error);
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).toContain('DPoP error="use_dpop_nonce"');
    expect(wwwAuthenticate(response)).not.toContain("detail");
    expect(response.headers.get("dpop-nonce")).toBe("fresh-1");
    expect(await bodyOf(response)).toMatchObject({ error: "use_dpop_nonce" });
  });

  it("reports invalid_dpop_proof when the core nonce fails the allowlist", async () => {
    const error = new AuthError("detail", "use_dpop_nonce", 401, {
      "DPoP-Nonce": "bad\r\nnonce",
    });
    const response = await failWith(error);
    expect(response.status).toBe(401);
    expect(wwwAuthenticate(response)).toContain(
      'DPoP error="invalid_dpop_proof"',
    );
    expect(wwwAuthenticate(response)).not.toContain("use_dpop_nonce");
    expect(response.headers.get("dpop-nonce")).toBeNull();
    const none = await failWith(new AuthError("detail", "use_dpop_nonce", 401));
    expect(wwwAuthenticate(none)).toContain('DPoP error="invalid_dpop_proof"');
  });

  it("recognizes a nonce-required error signalled through the cause code", async () => {
    const error = Object.assign(new InvalidDpopProofError("x"), {
      cause: { code: "use_dpop_nonce" },
    });
    expect((await failWith(error)).status).toBe(401);
  });

  it("keeps the core status for other auth errors with a client-facing status", async () => {
    const forbidden = await failWith(new AuthError("detail", "custom", 403));
    expect(forbidden.status).toBe(403);
    expect(wwwAuthenticate(forbidden)).toContain('error="insufficient_scope"');
    const unauthorized = await failWith(new AuthError("detail", "custom", 401));
    expect(unauthorized.status).toBe(401);
    const badRequest = await failWith(new AuthError("detail", "custom", 400));
    expect(badRequest.status).toBe(400);
    expect(wwwAuthenticate(badRequest)).toContain('error="invalid_request"');
    expect(
      (await failWith(new AuthError("detail", "custom", 502))).status,
    ).toBe(500);
    expect((await failWith(new AuthError("detail", "custom"))).status).toBe(
      500,
    );
  });
});

describe("metadata path validation", () => {
  it.each([
    "prm",
    "/prm?x=1",
    "/prm#frag",
    "//evil.example/prm",
    "/a/../prm",
    "/a b",
    "//[bad",
    "/é",
    "",
  ])("rejects %j", (path) => {
    expect(() => makeHandler({ metadata: { path } })).toThrow(
      InvalidConfigurationError,
    );
  });

  it("accepts a normalized path and advertises exactly the matched route", async () => {
    const { handle } = makeHandler({ metadata: { path: "/docs/prm.json" } });
    const challenge = wwwAuthenticate(await handle(request())) ?? "";
    const advertised = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
    expect(advertised).toBe("https://mcp.example.com/docs/prm.json");
    expect(
      (await handle(request({}, { method: "GET" }, advertised))).status,
    ).toBe(200);
  });
});

describe("realm validation", () => {
  it.each(["", " ", "\t ", 'a"b', "a\\b", "a\nb", "é", 42 as unknown as string])(
    "rejects %j",
    (realm) => {
      expect(() => makeHandler({ realm })).toThrow(InvalidConfigurationError);
    },
  );

  it("accepts a clean realm", () => {
    expect(() => makeHandler({ realm: "my mcp" })).not.toThrow();
  });
});

describe("onError observer failures", () => {
  it("swallows a rejected promise returned by onError without changing the response", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      useTenant();
      // Plain function: vi.fn would attach its own handler to the returned promise.
      let calls = 0;
      const onError = () => {
        calls += 1;
        return Promise.reject(new Error("observer down"));
      };
      const { handle } = makeHandler({ onError }, async () => {
        throw new Error("boom");
      });
      const response = await handle(request(await bearer()));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);
      expect(response.status).toBe(500);
      expect(await bodyOf(response)).toEqual({
        error: "server_error",
        error_description: "Internal server error.",
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("malformed request url", () => {
  it.each(["not a url", "/relative/path", ""])(
    "answers 400 invalid_request with a challenge for %j instead of throwing",
    async (url) => {
      const { handle } = makeHandler();
      const response = await handle({
        url,
        method: "POST",
        headers: new Headers(),
      } as unknown as Request);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ error: "invalid_request" });
      expect(wwwAuthenticate(response)).toContain('error="invalid_request"');
    },
  );
});

describe("pre-verification responses never escape", () => {
  it("returns a generic 500 when building the no-credential response throws", async () => {
    const { handle } = makeHandler({ realm: "ok" });
    const spy = vi.spyOn(Headers.prototype, "append").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const absent = await handle(request());
      const malformed = await handle(request({ authorization: "Bearer a b" }));
      expect(absent.status).toBe(500);
      expect(malformed.status).toBe(500);
      expect(await bodyOf(absent)).toEqual({
        error: "server_error",
        error_description: "Internal server error.",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("configuration", () => {
  it("rejects a resource that is not an absolute URL", () => {
    expect(() => makeHandler({ resource: "not a url" })).toThrow(TypeError);
  });
});
