import {
  InvalidConfigurationError,
  VerifyAccessTokenError,
} from "@auth0/auth0-api-js";
import type { ApiClient } from "@auth0/auth0-api-js";
import { describe, expect, it } from "vitest";
import {
  DownscopedTokenError,
  InsufficientScopeError,
  MemoryIndexedTokenStore,
  UnauthenticatedError,
  createEncryptedTokenStore,
  createMcpClient,
  createMcpHandler,
  getCallerPrincipal,
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
    getTokenForService: unused,
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
    expect(() => requireScopes([], principal)).not.toThrow();
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
