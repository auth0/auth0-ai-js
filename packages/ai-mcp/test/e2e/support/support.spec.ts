/** Hermetic checks of the e2e helpers. They need no tenant and run with the normal unit suite. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildDpopProof,
  generateDpopKeyPair,
  installFetchCounter,
  installFetchFault,
  buildTools,
  startMcpServer,
  startWebMcpServer,
  TOKEN_EXCHANGE_GRANT,
} from "./index.js";
import type { E2eEnv } from "./index.js";
import defaultConfig from "../../../vitest.config.js";
import e2eConfig from "../../../vitest.e2e.config.js";
import { evaluateClientPrerequisites, managementGet, mintManagementToken } from "./tenant-settings.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch() {
  const stub = vi.fn(async () => new Response("ok", { status: 200 }));
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

const exchangeBody = new URLSearchParams({ grant_type: TOKEN_EXCHANGE_GRANT }).toString();

describe("installFetchFault", () => {
  it("answers a matching request with the given status and body, then passes through after `times`", async () => {
    const stub = stubFetch();
    const fault = installFetchFault(
      { urlIncludes: "/oauth/token", method: "post", grantType: TOKEN_EXCHANGE_GRANT },
      { kind: "status", status: 503, body: { error: "server_error" } },
      { times: 1 },
    );
    const call = () => fetch("https://tenant.test/oauth/token", { method: "POST", body: exchangeBody });
    const first = await call();
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "server_error" });
    expect((await call()).status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(fault.injected).toBe(1);
  });

  it("leaves non-matching requests alone", async () => {
    const stub = stubFetch();
    installFetchFault({ grantType: TOKEN_EXCHANGE_GRANT }, { kind: "network" });
    const other = await fetch("https://tenant.test/oauth/token", {
      method: "POST",
      body: "grant_type=client_credentials",
    });
    expect(other.status).toBe(200);
    expect((await fetch("https://tenant.test/.well-known/jwks.json")).status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it("rejects with a TypeError for a network fault and delays for a delay fault", async () => {
    const stub = stubFetch();
    const network = installFetchFault({ urlIncludes: "jwks" }, { kind: "network" }, { times: 1 });
    await expect(fetch("https://tenant.test/.well-known/jwks.json")).rejects.toBeInstanceOf(TypeError);
    network.restore();
    installFetchFault({}, { kind: "delay", ms: 30 });
    const started = Date.now();
    expect((await fetch("https://tenant.test/x")).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("cuts a delay fault short when the request is aborted", async () => {
    const stub = stubFetch();
    const fault = installFetchFault({}, { kind: "delay", ms: 5000 });
    const started = Date.now();
    await expect(fetch("https://tenant.test/x", { signal: AbortSignal.timeout(50) })).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fault.injected).toBe(1);
    expect(stub).not.toHaveBeenCalled();
  });

  it("restores in LIFO order and tolerates out-of-order restore", async () => {
    const stub = stubFetch();
    const base = globalThis.fetch;
    const inner = installFetchFault({}, { kind: "status", status: 500 });
    const outer = installFetchFault({ urlIncludes: "never-matches" }, { kind: "network" });
    inner.restore();
    expect((await fetch("https://tenant.test/x")).status).toBe(200);
    outer.restore();
    expect(globalThis.fetch).not.toBe(base);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("composes with the counter: the later install is the outer wrapper", async () => {
    stubFetch();
    const fault = installFetchFault({ grantType: TOKEN_EXCHANGE_GRANT }, { kind: "status", status: 503 });
    const counter = installFetchCounter();
    const call = () => fetch("https://tenant.test/oauth/token", { method: "POST", body: exchangeBody });
    expect((await call()).status).toBe(503);
    expect(counter.exchanges).toBe(1);
    counter.restore();
    fault.restore();
  });
});

describe("DPoP proof helper", () => {
  it("builds an RFC 9449 proof that verifies with its embedded key and binds the token", async () => {
    const keys = await generateDpopKeyPair();
    const proof = await buildDpopProof(keys, {
      htm: "post",
      htu: "https://mcp.example.test/mcp",
      accessToken: "opaque-test-token",
    });
    const header = decodeProtectedHeader(proof);
    expect(header.typ).toBe("dpop+jwt");
    expect(header.alg).toBe("ES256");
    expect(header.jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(header.jwk).not.toHaveProperty("d");
    const { payload } = await jwtVerify(proof, await importJWK(keys.jwk, "ES256"));
    expect(payload["htm"]).toBe("POST");
    expect(payload["htu"]).toBe("https://mcp.example.test/mcp");
    expect(payload["ath"]).toBe(createHash("sha256").update("opaque-test-token").digest("base64url"));
    expect(typeof payload["jti"]).toBe("string");
    expect(typeof payload.iat).toBe("number");
    expect(keys.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates a distinct key pair each time", async () => {
    expect((await generateDpopKeyPair()).jkt).not.toBe((await generateDpopKeyPair()).jkt);
  });
});

describe("startWebMcpServer (no tenant needed for unauthenticated routes)", () => {
  const env = {
    domain: "tenant.example.test",
    issuer: "https://tenant.example.test/",
    mcpAudience: "https://mcp.example.test/api",
    downstreamAudience: "https://work.example.test",
    downstreamScope: "work:read",
    oboClientId: "client",
    oboClientSecret: "not-a-real-secret",
  } as unknown as E2eEnv;

  it("serves the metadata route and challenges a request without credentials", async () => {
    const server = await startWebMcpServer({ env, downstreamUrl: "http://127.0.0.1:1/" });
    try {
      expect(server.htu).toBe("https://mcp.example.test/mcp");
      const meta = await fetch(server.metadataUrl);
      expect(meta.status).toBe(200);
      const doc = (await meta.json()) as { resource: string; authorization_servers: string[] };
      expect(doc.resource).toBe(env.mcpAudience);
      expect(doc.authorization_servers).toEqual([env.issuer]);
      const denied = await fetch(server.url, { method: "POST", body: "{}" });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain(
        "resource_metadata=\"https://mcp.example.test/.well-known/oauth-protected-resource/api\"",
      );
      const viaHandle = await server.handle(new Request("https://mcp.example.test/mcp", { method: "GET" }));
      expect(viaHandle.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("startWebMcpServer with explicit endpoints (no tenant needed)", () => {
  const env = {
    domain: "tenant.example.test",
    issuer: "https://tenant.example.test/",
    mcpAudience: "https://mcp.example.test/api",
    downstreamAudience: "https://work.example.test",
    downstreamScope: "work:read",
    oboClientId: "client",
    oboClientSecret: "not-a-real-secret",
  } as unknown as E2eEnv;

  it("publishes the same metadata as the defaults", async () => {
    const server = await startWebMcpServer({
      env,
      downstreamUrl: "http://127.0.0.1:1/",
      explicitEndpoints: true,
    });
    try {
      const doc = (await (await fetch(server.metadataUrl)).json()) as {
        resource: string;
        authorization_servers: string[];
      };
      expect(doc.resource).toBe(env.mcpAudience);
      expect(doc.authorization_servers).toEqual([env.issuer]);
    } finally {
      await server.close();
    }
  });
});

describe("startMcpServer options (no tenant needed)", () => {
  const env = {
    domain: "tenant.example.test",
    issuer: "https://tenant.example.test/",
    mcpAudience: "https://mcp.example.test/api",
    downstreamAudience: "https://work.example.test",
    downstreamScope: "work:read",
    oboClientId: "client",
    oboClientSecret: "not-a-real-secret",
  } as unknown as E2eEnv;

  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  async function toolNames(deps: Parameters<typeof buildTools>[0]): Promise<string[]> {
    const mcp = buildTools(deps);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "probe", version: "1.0.0" });
    await mcp.connect(serverSide);
    await client.connect(clientSide);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
      await mcp.close();
    }
  }

  it("listens on the fixed port when one is given", async () => {
    const port = await freePort();
    const server = await startMcpServer({ env, downstreamUrl: "http://127.0.0.1:1/", port });
    try {
      expect(server.url.port).toBe(String(port));
      const denied = await fetch(server.url, { method: "POST", body: "{}" });
      expect(denied.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("takes an ephemeral port by default", async () => {
    const server = await startMcpServer({ env, downstreamUrl: "http://127.0.0.1:1/" });
    try {
      expect(Number(server.url.port)).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("passes requestTimeoutMs to the client, which rejects an invalid value", async () => {
    const ok = await startMcpServer({ env, downstreamUrl: "http://127.0.0.1:1/", requestTimeoutMs: 500 });
    await ok.close();
    await expect(
      startMcpServer({ env, downstreamUrl: "http://127.0.0.1:1/", requestTimeoutMs: 0 }),
    ).rejects.toThrow(/requestTimeoutMs/);
  });

  it("registers multi-downstream only when downstreams are given", async () => {
    const base = { downstreamUrl: "http://127.0.0.1:1/", env };
    expect(await toolNames({ ...base, downstreams: [] })).toEqual(["delegate", "service", "whoami"]);
    expect(
      await toolNames({
        ...base,
        downstreams: [{ audience: "https://orders.example.test", url: "http://127.0.0.1:2/" }],
      }),
    ).toEqual(["delegate", "multi-downstream", "service", "whoami"]);
  });
});

describe("managementGet", () => {
  it("sends a GET with a bearer token and returns status and parsed body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200 }));
    const result = await managementGet(fetchImpl as unknown as typeof fetch, {
      domain: "tenant.test",
      token: "t",
      path: "/api/v2/tenants/settings",
    });
    expect(result).toEqual({ status: 200, body: { a: 1 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tenant.test/api/v2/tenants/settings");
    expect(init.method).toBe("GET");
  });

  it.each(["POST", "PATCH", "PUT", "DELETE", "post", "HEAD", "get", "Get"])("throws for %s before any request is made", async (method) => {
    const fetchImpl = vi.fn();
    await expect(
      managementGet(fetchImpl as unknown as typeof fetch, {
        domain: "tenant.test",
        token: "t",
        path: "/api/v2/tenants/settings",
        method,
      }),
    ).rejects.toThrow(/GET only/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a path outside the Management API", async () => {
    const fetchImpl = vi.fn();
    await expect(
      managementGet(fetchImpl as unknown as typeof fetch, { domain: "tenant.test", token: "t", path: "/oauth/token" }),
    ).rejects.toThrow(/\/api\/v2\//);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v2/../../oauth/token",
    "/api/v2/%2e%2e/oauth/token",
    "/api/v2/%2E%2E/oauth/token",
    "/api/v2/..%2foauth/token",
    "/api/v2/..\\oauth/token",
    "https://evil.example/api/v2/x",
    "//evil.example/api/v2/x",
  ])("refuses the path %s before any request is made", async (path) => {
    const fetchImpl = vi.fn();
    await expect(
      managementGet(fetchImpl as unknown as typeof fetch, { domain: "tenant.test", token: "t", path }),
    ).rejects.toThrow(/Management API path/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a good path with a query string", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await managementGet(fetchImpl as unknown as typeof fetch, {
      domain: "tenant.test",
      token: "t",
      path: "/api/v2/clients?fields=name",
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://tenant.test/api/v2/clients?fields=name");
  });

  it.each(["x@evil.test", "evil.test/path", "evil.test:8443", "https://evil.test", "evil.test?x=1", "a b.test", "", "-bad.test", "a..test"])(
    "refuses the domain %j before any request is made",
    async (domain) => {
      const fetchImpl = vi.fn();
      await expect(
        managementGet(fetchImpl as unknown as typeof fetch, { domain, token: "t", path: "/api/v2/tenants/settings" }),
      ).rejects.toThrow(/Tenant domain must be a bare host name/);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("does not put the token in the result or in an error when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>secret-token-value</html>", { status: 500 }));
    const result = await managementGet(fetchImpl as unknown as typeof fetch, {
      domain: "tenant.test",
      token: "secret-token-value",
      path: "/api/v2/tenants/settings",
    });
    expect(result).toEqual({ status: 500, body: {} });
  });

  it("passes a 10 second timeout signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
      await managementGet(fetchImpl as unknown as typeof fetch, {
        domain: "tenant.test",
        token: "t",
        path: "/api/v2/tenants/settings",
      });
      expect(timeout).toHaveBeenCalledWith(10_000);
      const init = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(init[1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("mintManagementToken", () => {
  const creds = { domain: "tenant.test", clientId: "the-client-id", clientSecret: "the-client-secret" };
  const asFetch = (f: unknown) => f as typeof fetch;

  it("posts the client credentials grant for the Management API audience and returns the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "abc" }), { status: 200 }));
    await expect(mintManagementToken(asFetch(fetchImpl), creds)).resolves.toBe("abc");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tenant.test/oauth/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("audience")).toBe("https://tenant.test/api/v2/");
    expect(form.get("client_id")).toBe("the-client-id");
    expect(form.get("client_secret")).toBe("the-client-secret");
  });

  const leaky = ["the-client-secret", "the-client-id", "leaked-access-token"];
  it.each([
    ["a non-2xx response", () => new Response(JSON.stringify({ error: "access_denied", error_description: leaky.join(" ") }), { status: 401 }), /HTTP 401, error access_denied/],
    ["a non-JSON response", () => new Response(`<html>${leaky.join(" ")}</html>`, { status: 502 }), /HTTP 502, error unknown/],
    ["a response without access_token", () => new Response(JSON.stringify({ token_type: "Bearer", note: leaky.join(" ") }), { status: 200 }), /HTTP 200, error unknown/],
  ])("throws without leaking secrets on %s", async (_name, respond, message) => {
    const fetchImpl = vi.fn(async () => respond());
    const error = await mintManagementToken(asFetch(fetchImpl), creds).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    for (const secret of leaky) expect((error as Error).message).not.toContain(secret);
  });

  it("refuses a bad domain before any request is made", async () => {
    const fetchImpl = vi.fn();
    await expect(mintManagementToken(asFetch(fetchImpl), { ...creds, domain: "x@evil.test" })).rejects.toThrow(
      /Tenant domain must be a bare host name/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes a 10 second timeout signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "abc" }), { status: 200 }));
      await mintManagementToken(asFetch(fetchImpl), creds);
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects when the request is aborted by the signal", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) reject(new Error("aborted"));
        }),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    try {
      await expect(mintManagementToken(asFetch(fetchImpl), creds)).rejects.toThrow();
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("evaluateClientPrerequisites", () => {
  const good = { client_id_metadata_document_supported: true, resource_parameter_profile: "compatibility" };

  it("passes when both settings are correct", () => {
    expect(evaluateClientPrerequisites(good)).toEqual({ cimd: "on", profile: "compatibility", failures: [] });
  });

  it("fails with the exact action when CIMD registration is off", () => {
    const r = evaluateClientPrerequisites({ ...good, client_id_metadata_document_supported: false });
    expect(r.cimd).toBe("off");
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("Turn on Client ID Metadata Document Registration in Settings > Advanced");
    expect(r.failures[0]).toContain("not an SDK regression");
  });

  it("fails with the exact action when the profile is audience", () => {
    const r = evaluateClientPrerequisites({ ...good, resource_parameter_profile: "audience" });
    expect(r.profile).toBe("audience");
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain(
      "Set Resource Parameter Compatibility Profile to compatibility in Settings > Advanced",
    );
    expect(r.failures[0]).toContain("currently audience");
    expect(r.failures[0]).toContain("not an SDK regression");
  });

  it("names both settings when both are wrong", () => {
    const r = evaluateClientPrerequisites({
      client_id_metadata_document_supported: false,
      resource_parameter_profile: "audience",
    });
    expect(r.failures).toHaveLength(2);
    expect(r.failures.join("\n")).toContain("Client ID Metadata Document Registration");
    expect(r.failures.join("\n")).toContain("Resource Parameter Compatibility Profile");
  });

  it.each([undefined, null, "text", 5, [], {}, { client_id_metadata_document_supported: "yes", resource_parameter_profile: 3 }])(
    "reports unknown instead of passing for an unreadable response (%j)",
    (settings) => {
      const r = evaluateClientPrerequisites(settings);
      expect(r.cimd).toBe("unknown");
      expect(r.profile).toBe("unknown");
      expect(r.failures).toHaveLength(2);
      expect(r.failures[0]).toContain("could not be read");
      expect(r.failures[1]).toContain("could not be read");
    },
  );

  it("reports only the unreadable setting as unknown", () => {
    const r = evaluateClientPrerequisites({ client_id_metadata_document_supported: true });
    expect(r.cimd).toBe("on");
    expect(r.profile).toBe("unknown");
    expect(r.failures).toHaveLength(1);
  });
});

describe("default CI never runs the real-tenant specs", () => {
  const e2eDir = new URL("..", import.meta.url);

  function specFiles(dir: URL): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? specFiles(new URL(`${entry.name}/`, dir))
        : entry.name.includes(".e2e.") && entry.name.endsWith(".spec.ts")
          ? [entry.name]
          : [],
    );
  }

  it("excludes the e2e spec glob from the default config and includes it only in the e2e config", () => {
    expect(defaultConfig.test?.exclude).toContain("test/e2e/**/*.e2e.spec.ts");
    expect(defaultConfig.test?.exclude).toContain("test/e2e/**/*.e2e.slow.spec.ts");
    expect(e2eConfig.test?.include).toEqual(["test/e2e/**/*.e2e.spec.ts"]);
  });

  it("names every real-tenant spec so the exclude glob covers it", () => {
    const names = specFiles(e2eDir);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/\.e2e(\.slow)?\.spec\.ts$/);
  });

  it("keeps the default test script free of the e2e config", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test"]).toBe("vitest run");
    expect(pkg.scripts["test"]).not.toContain("e2e");
  });
});
