import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import type { ApiClient } from "@auth0/auth0-api-js";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMcpClient,
  createMcpHandler,
  mcpClientOptionsFromEnv,
  resolveMcpClientOptions,
} from "../../src/index.js";
import type { AuthInfo, McpClient, Principal, RequestScopedMcpClient } from "../../src/index.js";
import { asTokenVerifier, createMcpSdkHandler, toNodeHandler } from "../../src/mcp-sdk.js";

/**
 * Pins statements of the guides about the contract of the handler and the adapters: the
 * challenge and the metadata document that follow `requiredScopes`, the response headers,
 * `AuthInfo`, the Node adapter, `asTokenVerifier`, the environment rules and the protocol
 * revision the SDK adapter serves. Each test names the statement it backs.
 */

const RESOURCE = "https://mcp.example.com/mcp";
const ISSUERS = ["https://your-tenant.us.auth0.com/"];

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
function doc(...parts: string[]): string {
  return readFileSync(path.join(packageDir, ...parts), "utf8");
}

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

function stubClient(extra: Partial<McpClient> = {}, scopes: string[] = []): McpClient {
  return {
    dpopMode: "allowed",
    audience: RESOURCE,
    domain: "your-tenant.us.auth0.com",
    verifyAccessToken: (async () => ({ principal: principalWith(scopes) })) as McpClient["verifyAccessToken"],
    withToken: ((caller: { principal: Principal }) => scopedClient(caller.principal)) as McpClient["withToken"],
    ...extra,
  };
}

function post(headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const BEARER = { authorization: "Bearer abc.def.ghi" };

describe("requiredScopes and the challenge (Handler.md, ScopeEnforcement.md)", () => {
  const make = (requiredScopes: string[], metadata?: { scopesSupported?: string[] }) =>
    createMcpHandler({
      client: stubClient(),
      authorizationServers: ISSUERS,
      requiredScopes,
      ...(metadata !== undefined && { metadata }),
      handler: async () => new Response("ok"),
    });
  const metadataOf = async (handle: (request: Request) => Promise<Response>) =>
    (await (await handle(new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"))).json()) as {
      scopes_supported?: string[];
    };

  it("splits entries on whitespace, counts duplicates once and sends the scopes in the missing-credential 401", async () => {
    const handle = make(["read write", "read"]);

    const response = await handle(post());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('scope="read write"');
    expect(response.headers.get("www-authenticate")).not.toContain("error=");
    expect((await metadataOf(handle)).scopes_supported).toEqual(["read", "write"]);
  });

  it("publishes requiredScopes as scopes_supported unless metadata.scopesSupported is set", async () => {
    expect((await metadataOf(make(["mcp:access"]))).scopes_supported).toEqual(["mcp:access"]);
    expect((await metadataOf(make(["mcp:access"], { scopesSupported: ["mcp:access", "tool:admin"] }))).scopes_supported)
      .toEqual(["mcp:access", "tool:admin"]);
  });

  it("treats an empty list as no requirement and rejects a blank or non-string entry at creation", async () => {
    const none = make([]);
    const response = await none(post());
    expect(response.headers.get("www-authenticate")).not.toContain("scope=");
    expect((await metadataOf(none)).scopes_supported).toBeUndefined();

    expect(() => make([" "])).toThrow(InvalidConfigurationError);
    expect(() => make([42 as unknown as string])).toThrow(InvalidConfigurationError);
  });

  it("says so in the guides", () => {
    expect(doc("docs", "Handler.md")).toContain("split on whitespace");
    expect(doc("docs", "Handler.md")).toContain("`scope` of the 401 challenge");
    expect(doc("docs", "ScopeEnforcement.md")).toContain("`scopes_supported`");
  });
});

describe("response headers (Handler.md)", () => {
  const handle = createMcpHandler({
    client: stubClient(),
    authorizationServers: ISSUERS,
    handler: async () => {
      throw new Error("boom");
    },
  });

  it("sets cache-control: no-store on failures, including the 500, and a public max-age on the metadata", async () => {
    expect((await handle(post())).headers.get("cache-control")).toBe("no-store");
    expect((await handle(post({ authorization: "Bearer a b" }))).headers.get("cache-control")).toBe("no-store");
    expect((await handle(post(BEARER))).status).toBe(500);
    expect((await handle(post(BEARER))).headers.get("cache-control")).toBe("no-store");
    const metadata = await handle(new Request("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"));
    expect(metadata.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(doc("docs", "Handler.md")).toContain("`cache-control: no-store`");
  });
});

describe("AuthInfo (Handler.md)", () => {
  it("has an empty token, the scopes and a different resource object for every request", async () => {
    const seen: AuthInfo[] = [];
    const handle = createMcpHandler({
      client: stubClient({}, ["a", "b"]),
      authorizationServers: ISSUERS,
      handler: async (_request, authInfo) => {
        seen.push(authInfo);
        return new Response("ok");
      },
    });

    await handle(post(BEARER));
    await handle(post(BEARER));

    expect(seen).toHaveLength(2);
    expect(seen[0]!.token).toBe("");
    expect(seen[0]!.scopes).toEqual(["a", "b"]);
    expect(seen[0]!.resource).not.toBe(seen[1]!.resource);
  });

  it("hands every request a fresh resource, so editing one changes nothing for the next", async () => {
    let calls = 0;
    const hrefs: string[] = [];
    const handle = createMcpHandler({
      client: stubClient(),
      authorizationServers: ISSUERS,
      handler: async (_request, authInfo) => {
        hrefs.push(authInfo.resource!.href);
        if (calls++ === 0) authInfo.resource!.pathname = "/other";
        return new Response("ok");
      },
    });

    await handle(post(BEARER));
    await handle(post(BEARER));

    expect(hrefs).toEqual([RESOURCE, RESOURCE]);
    expect(doc("docs", "Handler.md")).toContain("Every request gets its own object");
  });
});

describe("a resource that is not a URL (Handler.md)", () => {
  it("throws the bare TypeError when the client declares no audience", () => {
    const attempt = () =>
      createMcpHandler({
        client: stubClient({ audience: undefined }),
        resource: "not-a-url",
        authorizationServers: ISSUERS,
        handler: async () => new Response("ok"),
      });

    expect(attempt).toThrow(TypeError);
    expect(attempt).not.toThrow(InvalidConfigurationError);
    expect(doc("docs", "Handler.md")).toContain("declares no audience");
  });
});

describe("the Node adapter (Handler.md)", () => {
  let http: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
    http = undefined;
  });

  async function send(listener: Parameters<typeof createServer>[1], method: string) {
    http = createServer(listener);
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    return new Promise<{ status: number; allow: string | undefined; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            allow: res.headers["allow"] as string | undefined,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("answers 405 with an Allow header for a method a Request cannot carry", async () => {
    const listener = toNodeHandler(async () => new Response("ok"), { resource: RESOURCE });

    const trace = await send(listener, "TRACE");

    expect(trace.status).toBe(405);
    expect(trace.allow).toBe("DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
    expect(doc("docs", "Handler.md")).toContain("`CONNECT`, `TRACE`, `TRACK`");
  });

  it("passes the raw error of its own 500 to onError, keeps it out of the response and ignores a throwing hook", async () => {
    const seen: unknown[] = [];
    const failing = new Error("internal detail");
    const listener = toNodeHandler(
      async () => {
        throw failing;
      },
      { resource: RESOURCE, onError: (error) => seen.push(error) },
    );

    const response = await send(listener, "GET");

    expect(response.status).toBe(500);
    expect(response.body).not.toContain("internal detail");
    expect(seen).toEqual([failing]);

    const quiet = toNodeHandler(
      async () => {
        throw failing;
      },
      {
        resource: RESOURCE,
        onError: () => {
          throw new Error("hook failed");
        },
      },
    );
    await new Promise<void>((resolve) => http!.close(() => resolve()));
    expect((await send(quiet, "GET")).status).toBe(500);
  });
});

describe("asTokenVerifier and the resource (KnownLimitations.md)", () => {
  const verifierFor = (audience: string) =>
    asTokenVerifier(stubClient({ audience, verifyAccessToken: (async () => ({ principal: principalWith(["a"]) })) as McpClient["verifyAccessToken"] }));

  it("returns the audience as a new URL for a URL audience, so expectedResource can take the same value", async () => {
    const verifier = verifierFor(RESOURCE);

    const first = await verifier.verifyAccessToken("t");
    const second = await verifier.verifyAccessToken("t");

    expect(first.resource?.href).toBe(RESOURCE);
    expect(first.resource).not.toBe(second.resource);
  });

  it("leaves the resource out for a URN audience, which is why expectedResource must not be set", async () => {
    const info = await verifierFor("urn:acme:mcp").verifyAccessToken("t");

    expect(info.resource).toBeUndefined();
    expect(doc("docs", "KnownLimitations.md")).toContain("such as a URN");
  });
});

describe("the protocol revision of the SDK adapter (KnownLimitations.md)", () => {
  it("answers server/discover with a JSON-RPC Method not found error", async () => {
    const handle = createMcpSdkHandler({
      client: stubClient(),
      authorizationServers: ISSUERS,
      createServer: () => new McpServer({ name: "docs", version: "1.0.0" }),
    });

    const response = await handle(post(BEARER, { jsonrpc: "2.0", id: 1, method: "server/discover" }));
    const body = (await response.json()) as { error?: { code: number } };

    expect(body.error?.code).toBe(-32601);
    const guide = doc("docs", "KnownLimitations.md");
    expect(guide).toContain("`server/discover`");
    expect(guide).toContain("2026-07-28");
    expect(guide).toContain("cannot connect");
  });

  it("serves the initialize handshake", async () => {
    const handle = createMcpSdkHandler({
      client: stubClient(),
      authorizationServers: ISSUERS,
      createServer: () => new McpServer({ name: "docs", version: "1.0.0" }),
    });

    const response = await handle(
      post(BEARER, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } },
      }),
    );
    const body = (await response.json()) as { result?: { serverInfo?: { name: string } } };

    expect(body.result?.serverInfo?.name).toBe("docs");
  });
});

describe("the environment (README.md)", () => {
  it("removes whitespace around the domain, the audience and the client id and keeps the secret as set", () => {
    expect(
      mcpClientOptionsFromEnv({
        AUTH0_DOMAIN: " tenant.example.com\n",
        AUTH0_AUDIENCE: "\thttps://mcp.example.com/mcp ",
        AUTH0_CLIENT_ID: " id\n",
        AUTH0_CLIENT_SECRET: " secret\n",
      }),
    ).toEqual({
      domain: "tenant.example.com",
      audience: "https://mcp.example.com/mcp",
      clientId: "id",
      clientSecret: " secret\n",
    });
    expect(doc("README.md")).toContain("Whitespace around `AUTH0_DOMAIN`");
  });

  it("supplies no client id or secret for an apiClient", () => {
    const apiClient = {} as unknown as ApiClient;
    const options = resolveMcpClientOptions(
      { apiClient },
      {
        AUTH0_DOMAIN: "tenant.example.com",
        AUTH0_AUDIENCE: RESOURCE,
        AUTH0_CLIENT_ID: "id",
        AUTH0_CLIENT_SECRET: "secret",
      },
    );

    expect(options.clientId).toBeUndefined();
    expect(options.clientSecret).toBeUndefined();
    expect(() => createMcpClient(options)).not.toThrow();
    expect(doc("README.md")).toContain("supplies no client id or secret");
  });
});
