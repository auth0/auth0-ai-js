import {
  InvalidConfigurationError,
  VerifyAccessTokenError,
} from "@auth0/auth0-api-js";
import type { ApiClient } from "@auth0/auth0-api-js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DownscopedTokenError,
  InsufficientScopeError,
  MemoryIndexedTokenStore,
  UnauthenticatedError,
  authenticateRequest,
  buildPrincipal,
  createEncryptedTokenStore,
  createMcpClient,
  createMcpHandler,
  getCallerPrincipal,
  mcpClientOptionsFromEnv,
  requireScopes,
  runWithRequestContext,
  withRequiredScopes,
} from "../../src/index.js";
import type {
  McpClient,
  Principal,
  RequestContext,
  RequestScopedMcpClient,
} from "../../src/index.js";

/**
 * Pins the behaviour statements made in README.md and docs/*.md. Each test names the
 * statement it backs.
 */

const RESOURCE = "https://mcp.example.com/mcp";

function principalWith(scopes: string[]): Principal {
  return {
    sub: "auth0|user-1",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scopes,
    permissions: null,
    clientId: "client-1",
    orgId: null,
  };
}

function scopedClient(principal: Principal): RequestScopedMcpClient {
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    getPrincipal: () => principal,
    getTokenOnBehalfOf: unused,
    getClientCredentialsToken: unused,
    getTokenForConnection: unused,
  };
}

function stubClient(
  verify: () => Promise<{ principal: Principal }>,
  dpopMode: McpClient["dpopMode"] = "allowed",
): McpClient {
  return {
    dpopMode,
    verifyAccessToken: verify as McpClient["verifyAccessToken"],
    withToken: ((caller: { principal: Principal }) =>
      scopedClient(caller.principal)) as McpClient["withToken"],
  };
}

function handlerFor(client: McpClient, extra: { requiredScopes?: string[] } = {}) {
  return createMcpHandler({
    client,
    resource: RESOURCE,
    authorizationServers: ["https://your-tenant.us.auth0.com/"],
    handler: async (_request, authInfo) =>
      Response.json({ scopes: authInfo.scopes, sub: authInfo.extra?.sub }),
    ...extra,
  });
}

function post(headers: Record<string, string> = {}): Request {
  return new Request(RESOURCE, { method: "POST", headers });
}

describe("handler responses (Handler.md, ScopeEnforcement.md, Errors.md)", () => {
  it("answers a missing credential with 401 and a challenge without an error value", async () => {
    const response = await handlerFor(
      stubClient(async () => ({ principal: principalWith([]) })),
    )(post());
    expect(response.status).toBe(401);
    const challenges = response.headers.get("www-authenticate") ?? "";
    expect(challenges).toContain("Bearer");
    expect(challenges).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(challenges).not.toContain("error=");
  });

  it("answers a malformed header with 400 invalid_request", async () => {
    const response = await handlerFor(
      stubClient(async () => ({ principal: principalWith([]) })),
    )(post({ authorization: "Bearer a b" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_request"',
    );
  });

  it("answers a token that fails verification with 401 invalid_token and a generic body", async () => {
    const response = await handlerFor(
      stubClient(async () => {
        throw new VerifyAccessTokenError("signature secret detail");
      }),
    )(post({ authorization: "Bearer abc.def.ghi" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    expect(await response.text()).not.toContain("secret detail");
  });

  it("answers a missing server-wide scope with 403 and lists only the missing scopes", async () => {
    const response = await handlerFor(
      stubClient(async () => ({ principal: principalWith(["other"]) })),
      { requiredScopes: ["mcp:access"] },
    )(post({ authorization: "Bearer abc.def.ghi" }));
    expect(response.status).toBe(403);
    const challenges = response.headers.get("www-authenticate") ?? "";
    expect(challenges).toContain('error="insufficient_scope"');
    expect(challenges).toContain('scope="mcp:access"');
    expect(challenges).not.toContain("other");
  });

  it("sends one challenge per accepted scheme in the default mode, Bearer only when disabled", async () => {
    const verify = async () => ({ principal: principalWith([]) });
    const allowed = await handlerFor(stubClient(verify, "allowed"))(post());
    expect(allowed.headers.get("www-authenticate")).toMatch(/^Bearer .*, DPoP /);
    const disabled = await handlerFor(stubClient(verify, "disabled"))(post());
    expect(disabled.headers.get("www-authenticate")).not.toContain("DPoP");
  });

  it("treats a Bearer request as unauthenticated when DPoP is required", async () => {
    const response = await handlerFor(
      stubClient(async () => ({ principal: principalWith([]) }), "required"),
    )(post({ authorization: "Bearer abc.def.ghi" }));
    expect(response.status).toBe(401);
    const challenges = response.headers.get("www-authenticate") ?? "";
    expect(challenges).toContain("DPoP");
    expect(challenges).not.toContain("Bearer");
    expect(challenges).not.toContain("error=");
  });

  it("serves the metadata document at the RFC 9728 well-known path", async () => {
    const response = await handlerFor(
      stubClient(async () => ({ principal: principalWith([]) })),
    )(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: ["https://your-tenant.us.auth0.com/"],
    });
  });

  it("defaults resource and authorizationServers from the client (Handler.md)", async () => {
    const client: McpClient = {
      ...stubClient(async () => ({ principal: principalWith([]) })),
      domain: "your-tenant.us.auth0.com",
      audience: RESOURCE,
    };
    const response = await createMcpHandler({
      client,
      handler: async () => Response.json({ ok: true }),
    })(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"),
    );
    expect(await response.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: ["https://your-tenant.us.auth0.com/"],
    });
  });

  it("throws when the audience is not a url and no resource is given (Handler.md)", () => {
    const client: McpClient = {
      ...stubClient(async () => ({ principal: principalWith([]) })),
      domain: "your-tenant.us.auth0.com",
      audience: "urn:acme:mcp",
    };
    expect(() =>
      createMcpHandler({ client, handler: async () => new Response("ok") }),
    ).toThrow(/the client audience is missing or is not an absolute http or https URL/);
  });

  it("maps this package's errors to statuses and turns other errors into a generic 500", async () => {
    const authenticated = stubClient(async () => ({
      principal: principalWith(["mcp:access"]),
    }));
    const thrower = (error: unknown) =>
      createMcpHandler({
        client: authenticated,
        resource: RESOURCE,
        authorizationServers: ["https://your-tenant.us.auth0.com/"],
        handler: async () => {
          throw error;
        },
      });
    const request = () => post({ authorization: "Bearer abc.def.ghi" });
    expect((await thrower(new UnauthenticatedError())(request())).status).toBe(401);
    expect(
      (await thrower(new InsufficientScopeError(["a"]))(request())).status,
    ).toBe(403);
    expect((await thrower(new DownscopedTokenError())(request())).status).toBe(403);
    const internal = await thrower(new Error("database password"))(request());
    expect(internal.status).toBe(500);
    expect(internal.headers.get("www-authenticate")).toBeNull();
    expect(await internal.text()).not.toContain("password");
  });
});

describe("scope enforcement (ScopeEnforcement.md)", () => {
  it("returns the documented error result for a tool the caller may not use", async () => {
    const principal = principalWith(["read:orders"]);
    const tool = withRequiredScopes(["read:orders", "read:payments"], async () => "ran");
    const result = await runWithRequestContext(
      { principal, mcpClient: scopedClient(principal) },
      () => tool(),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Missing one or more required scopes." }],
      isError: true,
      _meta: { error: "insufficient_scope" },
    });
  });

  it("runs the tool when every scope is held and ignores the permissions claim", async () => {
    const principal: Principal = {
      ...principalWith(["read:orders"]),
      permissions: ["read:payments"],
    };
    const context: RequestContext = {
      principal,
      mcpClient: scopedClient(principal),
    };
    const allowed = withRequiredScopes("read:orders", async () => "ran");
    expect(await runWithRequestContext(context, () => allowed())).toBe("ran");
    const denied = withRequiredScopes("read:payments", async () => "ran");
    expect(await runWithRequestContext(context, () => denied())).toMatchObject({
      isError: true,
    });
  });

  it("requireScopes throws UnauthenticatedError without a context and accepts space-delimited input", () => {
    expect(() => requireScopes("a")).toThrow(UnauthenticatedError);
    const principal = principalWith(["a", "b"]);
    expect(() => requireScopes("a b", principal)).not.toThrow();
    expect(() => requireScopes("a c", principal)).toThrow(InsufficientScopeError);
    expect(() => requireScopes([], principal)).toThrow(InvalidConfigurationError);
  });

  it("rejects a requirement that names no scope, once, when the wrapper is created (ScopeEnforcement.md)", () => {
    const noop = async () => "ran";
    for (const blank of ["", "   ", [], ["a", " "], [1 as unknown as string]]) {
      expect(() => withRequiredScopes(blank, noop), JSON.stringify(blank)).toThrow(
        InvalidConfigurationError,
      );
      expect(() => requireScopes(blank, principalWith(["a"])), JSON.stringify(blank)).toThrow(
        InvalidConfigurationError,
      );
    }
  });

  it("keeps its own copy of the required list (ScopeEnforcement.md)", async () => {
    const required = ["a"];
    const tool = withRequiredScopes(required, async () => "ran");
    required.push("b");
    const principal = principalWith(["a"]);
    const context: RequestContext = { principal, mcpClient: scopedClient(principal) };
    expect(await runWithRequestContext(context, () => tool())).toBe("ran");
  });

  it("keeps the required scopes out of the message", () => {
    try {
      requireScopes(["secret:scope"], principalWith([]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientScopeError);
      expect((error as Error).message).not.toContain("secret:scope");
      expect((error as InsufficientScopeError).requiredScopes).toEqual(["secret:scope"]);
    }
  });
});

describe("request context (RequestContext.md)", () => {
  it("is undefined outside a request and visible after await inside one", async () => {
    expect(getCallerPrincipal()).toBeUndefined();
    const principal = principalWith([]);
    const seen = await runWithRequestContext(
      { principal, mcpClient: scopedClient(principal) },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getCallerPrincipal()?.sub;
      },
    );
    expect(seen).toBe("auth0|user-1");
  });
});

describe("error reference (Errors.md)", () => {
  it("has the documented status and code per class", () => {
    expect(new UnauthenticatedError()).toMatchObject({ statusCode: 401, code: "invalid_token" });
    expect(new InsufficientScopeError([])).toMatchObject({ statusCode: 403, code: "insufficient_scope" });
    expect(new DownscopedTokenError()).toMatchObject({ statusCode: 403, code: "insufficient_scope" });
  });
});

describe("configuration (TokenCaching.md, OrganizationPolicy.md, Errors.md)", () => {
  const base = { domain: "your-tenant.us.auth0.com", audience: RESOURCE };

  it("rejects non_strict without an indexed store", () => {
    expect(() => createMcpClient({ ...base, scopeMatching: "non_strict" })).toThrow(
      InvalidConfigurationError,
    );
    expect(() =>
      createMcpClient({
        ...base,
        scopeMatching: "non_strict",
        tokenStore: { get: async () => undefined, set: async () => {}, delete: async () => {} },
      }),
    ).toThrow(InvalidConfigurationError);
  });

  it("accepts non_strict with an indexed store", () => {
    expect(() =>
      createMcpClient({
        ...base,
        scopeMatching: "non_strict",
        tokenStore: new MemoryIndexedTokenStore(),
      }),
    ).not.toThrow();
  });

  it("rejects an allowlist without the required policy", () => {
    expect(() => createMcpClient({ ...base, organizationId: ["org_abc123"] })).toThrow(
      InvalidConfigurationError,
    );
    expect(() =>
      createMcpClient({
        ...base,
        organizationPolicy: "required",
        organizationId: ["org_abc123"],
      }),
    ).not.toThrow();
  });

  it("rejects apiClient combined with core options", () => {
    expect(() =>
      createMcpClient({ ...base, apiClient: {} as ApiClient, clientId: "x" }),
    ).toThrow(InvalidConfigurationError);
  });

  it("requires an encryption secret of at least 32 characters", () => {
    const inner = new MemoryIndexedTokenStore();
    expect(() => createEncryptedTokenStore(inner, { secret: "a".repeat(31) })).toThrow(
      InvalidConfigurationError,
    );
    expect(() => createEncryptedTokenStore(inner, { secret: "a".repeat(32) })).not.toThrow();
  });

  it("limits the memory store to a positive size", () => {
    expect(() => new MemoryIndexedTokenStore({ maxEntries: 0 })).toThrow(
      InvalidConfigurationError,
    );
    expect(new MemoryIndexedTokenStore().size).toBe(0);
  });

  it("reports the configured DPoP mode", () => {
    expect(createMcpClient(base).dpopMode).toBe("allowed");
    expect(createMcpClient({ ...base, dpop: { mode: "required" } }).dpopMode).toBe("required");
  });
});

describe("narrowed grants (OnBehalfOf.md)", () => {
  const claims = {
    iss: "https://your-tenant.us.auth0.com/",
    sub: "auth0|user-1",
    aud: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    scope: "mcp:access",
    client_id: "client-1",
  };

  function clientWithGrant(grantedScopes: string[], scope?: string) {
    const apiClient = {
      verifyAccessToken: async () => claims,
      getTokenOnBehalfOf: async () => ({
        accessToken: "downstream-token",
        expiresAt: claims.exp,
        grantedScopes,
        ...(scope !== undefined && { scope }),
      }),
      getClientCredentialsToken: async () => ({
        accessToken: "server-token",
        expiresAt: claims.exp,
        ...(scope !== undefined && { scope }),
      }),
    } as unknown as ApiClient;
    return createMcpClient({ domain: "your-tenant.us.auth0.com", audience: RESOURCE, apiClient });
  }

  async function scopedFor(client: McpClient) {
    const caller = await client.verifyAccessToken({ accessToken: "t", scheme: "bearer" });
    return client.withToken(caller);
  }

  it("throws DownscopedTokenError when the grant lacks a requested scope", async () => {
    const scoped = await scopedFor(clientWithGrant(["read:reports"], "read:reports"));
    await expect(
      scoped.getTokenOnBehalfOf({
        audience: "https://reports-api.example.com",
        scope: "read:reports write:reports",
      }),
    ).rejects.toBeInstanceOf(DownscopedTokenError);
  });

  it("returns the grant when it covers the request, and enforces nothing when no scope is requested", async () => {
    const scoped = await scopedFor(clientWithGrant(["read:reports"]));
    const covered = await scoped.getTokenOnBehalfOf({
      audience: "https://reports-api.example.com",
      scope: "read:reports",
    });
    expect(covered.grantedScopes).toEqual(["read:reports"]);
    const unrestricted = await scoped.getTokenOnBehalfOf({
      audience: "https://reports-api.example.com",
    });
    expect(unrestricted.accessToken).toBe("downstream-token");
  });

  it("derives grantedScopes for client credentials from the request when the server omits scope", async () => {
    const scoped = await scopedFor(clientWithGrant([]));
    const token = await scoped.getClientCredentialsToken({
      audience: "https://internal-api.example.com",
      scope: "write:config read:config",
    });
    expect(token.grantedScopes).toEqual(["read:config", "write:config"]);
  });

  it("rejects an expired subject token with UnauthenticatedError", async () => {
    const client = createMcpClient({
      domain: "your-tenant.us.auth0.com",
      audience: RESOURCE,
      apiClient: {
        verifyAccessToken: async () => ({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }),
      } as unknown as ApiClient,
    });
    const caller = await client.verifyAccessToken({ accessToken: "t", scheme: "bearer" });
    expect(() => client.withToken(caller)).toThrow(UnauthenticatedError);
  });
});

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
function doc(...parts: string[]): string {
  return readFileSync(path.join(packageDir, ...parts), "utf8");
}

describe("configuration tiers and the environment (README.md, Handler.md, Errors.md)", () => {
  const base = { domain: "your-tenant.us.auth0.com", audience: RESOURCE };

  it("documents exactly the environment variables the helper reads", () => {
    const read = new Set<string>();
    const spy = new Proxy({} as Record<string, string | undefined>, {
      get(_target, key) {
        read.add(String(key));
        return undefined;
      },
    });
    mcpClientOptionsFromEnv(spy);
    expect([...read].sort()).toEqual([
      "AUTH0_AUDIENCE",
      "AUTH0_CLIENT_ID",
      "AUTH0_CLIENT_SECRET",
      "AUTH0_DOMAIN",
    ]);

    for (const file of [["README.md"], ["docs", "Handler.md"], ["docs", "Errors.md"]]) {
      const text = doc(...file);
      for (const name of read) {
        if (file[0] === "README.md") expect(text, `${file.join("/")} names ${name}`).toContain(name);
      }
      const mentioned = new Set(text.match(/AUTH0_[A-Z_]+/g) ?? []);
      for (const name of mentioned) {
        expect(read.has(name), `${file.join("/")} mentions ${name}`).toBe(true);
      }
    }
  });

  it("maps each documented variable to the documented option", () => {
    expect(
      mcpClientOptionsFromEnv({
        AUTH0_DOMAIN: "d",
        AUTH0_AUDIENCE: "a",
        AUTH0_CLIENT_ID: "i",
        AUTH0_CLIENT_SECRET: "s",
      }),
    ).toEqual({ domain: "d", audience: "a", clientId: "i", clientSecret: "s" });
    expect(mcpClientOptionsFromEnv({ AUTH0_DOMAIN: "  " })).toEqual({});
  });

  it("starts the README with a quickstart that uses the one-call form", () => {
    const readme = doc("README.md");
    const quickstart = readme.split("## Quickstart")[1]?.split("\n## ")[0] ?? "";
    expect(readme.indexOf("## Quickstart")).toBeLessThan(readme.indexOf("## How it works"));
    const blocks = [...quickstart.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("createNodeMcpHandler({\n  createServer:");
    expect(blocks[0]).not.toContain("createMcpClient");
    expect(blocks[1]).toContain("domain:");
    expect(blocks[1]).toContain("audience:");
    expect(blocks[1]).not.toContain("client:");
  });

  it("serves both metadata routes and names the suffixed one in the challenge (Handler.md)", async () => {
    const client: McpClient = {
      ...stubClient(async () => ({ principal: principalWith([]) })),
      domain: "your-tenant.us.auth0.com",
      audience: RESOURCE,
    };
    const handle = createMcpHandler({ client, handler: async () => new Response("ok") });
    const suffixed = await handle(new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"));
    const root = await handle(new Request("https://mcp.example.com/.well-known/oauth-protected-resource"));
    expect(suffixed.status).toBe(200);
    expect(await root.json()).toEqual(await suffixed.json());
    const other = await handle(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource", { method: "POST" }),
    );
    expect(other.status).toBe(405);
    expect(other.headers.get("allow")).toBe("GET");
    const challenge = (await handle(post())).headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("requires a resource that equals the audience, with the documented trailing slash message (Handler.md)", () => {
    const client: McpClient = {
      ...stubClient(async () => ({ principal: principalWith([]) })),
      domain: "your-tenant.us.auth0.com",
      audience: RESOURCE,
    };
    const create = (resource: string) =>
      createMcpHandler({ client, resource, handler: async () => new Response("ok") });
    expect(() => create("https://other.example.com/mcp")).toThrow(InvalidConfigurationError);
    expect(() => create("https://MCP.example.com/mcp")).not.toThrow();
    expect(() => create(RESOURCE)).not.toThrow();

    let message = "";
    try {
      create(`${RESOURCE}/`);
    } catch (error) {
      message = (error as Error).message;
    }
    const sentence = "The two differ only by a trailing slash, which counts as a difference.";
    expect(message).toContain(sentence);
    expect(message).not.toContain("example.com");
    expect(doc("docs", "Handler.md")).toContain(sentence);
  });

  it("cannot serve a non-URL audience, even with an explicit URL resource (Handler.md)", () => {
    const client: McpClient = {
      ...stubClient(async () => ({ principal: principalWith([]) })),
      domain: "your-tenant.us.auth0.com",
      audience: "urn:acme:mcp",
    };
    expect(() =>
      createMcpHandler({ client, resource: RESOURCE, handler: async () => new Response("ok") }),
    ).toThrow(InvalidConfigurationError);
  });

  it("rejects client combined with inline options without echoing values (README.md)", () => {
    const client = createMcpClient(base);
    let message = "";
    try {
      createMcpHandler({
        client,
        clientId: "secret-id",
        handler: async () => new Response("ok"),
      } as never);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      message = (error as Error).message;
    }
    expect(message).toContain('"client" cannot be combined with "clientId"');
    expect(message).not.toContain("secret-id");
  });

  it("builds the handler client from the environment and names the missing variable (README.md)", () => {
    const saved = { domain: process.env.AUTH0_DOMAIN, audience: process.env.AUTH0_AUDIENCE };
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_AUDIENCE;
    try {
      expect(() => createMcpHandler({ handler: async () => new Response("ok") })).toThrow(
        /Missing MCP client option "domain".*AUTH0_DOMAIN/,
      );
      process.env.AUTH0_DOMAIN = "your-tenant.us.auth0.com";
      process.env.AUTH0_AUDIENCE = RESOURCE;
      expect(() => createMcpHandler({ handler: async () => new Response("ok") })).not.toThrow();
    } finally {
      for (const [key, value] of Object.entries({ AUTH0_DOMAIN: saved.domain, AUTH0_AUDIENCE: saved.audience })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("authenticateRequest (Handler.md, Writing your own adapter)", () => {
  it("returns a ready response for a bad request and runs work in the request context for a good one", async () => {
    const client: McpClient = {
      ...stubClient(async () => ({ principal: principalWith(["mcp:access"]) })),
      domain: "your-tenant.us.auth0.com",
      audience: RESOURCE,
    };
    const rejected = await authenticateRequest(post(), { client });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.response.status).toBe(401);

    const accepted = await authenticateRequest(post({ authorization: "Bearer abc.def.ghi" }), {
      client,
      requiredScopes: ["mcp:access"],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.scheme).toBe("Bearer");
      expect(await accepted.run(async () => getCallerPrincipal()?.sub)).toBe("auth0|user-1");
      expect(accepted.authInfo.token).toBe("");
    }
  });

  it("rejects with InvalidConfigurationError for a resource that differs from the audience", async () => {
    const client: McpClient = {
      ...stubClient(async () => ({ principal: principalWith([]) })),
      domain: "your-tenant.us.auth0.com",
      audience: RESOURCE,
    };
    await expect(
      authenticateRequest(post(), { client, resource: "https://other.example.com/mcp" }),
    ).rejects.toBeInstanceOf(InvalidConfigurationError);
  });
});

describe("principal claims (TokenVerification.md)", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;

  it("prefers azp over client_id and accepts a token with neither", () => {
    expect(buildPrincipal({ sub: "u", exp, azp: "a", client_id: "c" }).clientId).toBe("a");
    expect(buildPrincipal({ sub: "u", exp, client_id: "c" }).clientId).toBe("c");
    expect(buildPrincipal({ sub: "u", exp }).clientId).toBeNull();
  });

  it("rejects malformed permissions and org_id claims without echoing them", () => {
    expect(() => buildPrincipal({ sub: "u", exp, permissions: "read" })).toThrow(UnauthenticatedError);
    expect(() => buildPrincipal({ sub: "u", exp, permissions: null })).toThrow(UnauthenticatedError);
    expect(() => buildPrincipal({ sub: "u", exp, org_id: 7 })).toThrow(UnauthenticatedError);
    expect(buildPrincipal({ sub: "u", exp, permissions: [] }).permissions).toEqual([]);
    expect(buildPrincipal({ sub: "u", exp, org_id: "" }).orgId).toBeNull();
    expect(() => buildPrincipal({ sub: "u", exp, org_id: 987654 })).toThrow(/invalid organization/);
    try {
      buildPrincipal({ sub: "u", exp, org_id: 987654 });
    } catch (error) {
      expect((error as Error).message).not.toContain("987654");
    }
  });
});

describe("expired token results (OnBehalfOf.md, TokenVault.md)", () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://your-tenant.us.auth0.com/",
    sub: "auth0|user-1",
    aud: RESOURCE,
    exp: nowSeconds() + 3600,
    iat: nowSeconds(),
    scope: "mcp:access",
    client_id: "client-1",
  };

  async function scopedWithExpiry(expiresAt: number) {
    const result = { accessToken: "secret-token-value", expiresAt, scope: "read:reports" };
    const apiClient = {
      verifyAccessToken: async () => claims,
      getTokenOnBehalfOf: async () => ({ ...result, grantedScopes: ["read:reports"] }),
      getClientCredentialsToken: async () => result,
      getAccessTokenForConnection: async () => ({ ...result, connection: "google-oauth2" }),
    } as unknown as ApiClient;
    const client = createMcpClient({ domain: "your-tenant.us.auth0.com", audience: RESOURCE, apiClient });
    return client.withToken(await client.verifyAccessToken({ accessToken: "t", scheme: "bearer" }));
  }

  it("rejects an expired or non-finite expiry with the generic error and no token data", async () => {
    for (const expiresAt of [nowSeconds() - 5, nowSeconds(), Number.NaN]) {
      const scoped = await scopedWithExpiry(expiresAt);
      const calls = [
        () => scoped.getTokenOnBehalfOf({ audience: "https://api.example.com", scope: "read:reports" }),
        () => scoped.getClientCredentialsToken({ audience: "https://api.example.com", scope: "read:reports" }),
        () => scoped.getTokenForConnection({ connection: "google-oauth2" }),
      ];
      for (const call of calls) {
        const error = await call().then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        expect(error?.message).toBe("The token operation failed.");
        expect(JSON.stringify(error)).not.toContain("secret-token-value");
        expect(String((error as { cause?: unknown }).cause)).not.toContain("secret-token-value");
      }
    }
  });

  it("returns a result that has not expired", async () => {
    const scoped = await scopedWithExpiry(nowSeconds() + 600);
    const token = await scoped.getTokenForConnection({ connection: "google-oauth2" });
    expect(token.accessToken).toBe("secret-token-value");
  });
});

describe("renamed connection method (README.md, docs)", () => {
  it("no document uses the old name", () => {
    for (const file of [
      ["README.md"],
      ["EXAMPLES.md"],
      ["docs", "TokenVault.md"],
      ["docs", "RequestContext.md"],
    ]) {
      expect(doc(...file), file.join("/")).not.toMatch(/getTokenForService|ServiceTokenResult|TokenForServiceOptions/);
    }
    expect(doc("docs", "TokenVault.md")).toContain("getTokenForConnection");
  });
});
