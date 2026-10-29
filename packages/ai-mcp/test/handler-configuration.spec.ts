import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupServer } from "msw/node";
import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import { createMcpClient } from "../src/client.js";
import { createMcpHandler } from "../src/handler.js";
import { createMcpSdkHandler, createNodeMcpHandler } from "../src/mcp-sdk.js";
import { createAuth0Handlers, createTestKey, mintAccessToken } from "./support/index.js";
import type { TestKey } from "./support/index.js";

const ROOT_PRM = "https://mcp.example.com/.well-known/oauth-protected-resource";

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  tenant = createAuth0Handlers({ key });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

function clientFor(audience: string) {
  return createMcpClient({ domain: "tenant.example.com", audience });
}

function build(audience: string, resource?: string) {
  return createMcpHandler({
    client: clientFor(audience),
    ...(resource !== undefined && { resource }),
    handler: async () => new Response("ok"),
  });
}

function get(url: string) {
  return new Request(url, { method: "GET" });
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("protected resource metadata routes", () => {
  it("serves the suffixed and the root route for a resource with a path", async () => {
    const handle = build("https://mcp.example.com/mcp");
    const suffixed = await handle(get(`${ROOT_PRM}/mcp`));
    const root = await handle(get(ROOT_PRM));
    expect(suffixed.status).toBe(200);
    expect(root.status).toBe(200);
    const rootBody = await json(root);
    expect(rootBody).toEqual(await json(suffixed));
    expect(rootBody["resource"]).toBe("https://mcp.example.com/mcp");
  });

  it("points the challenge at the suffixed route", async () => {
    const handle = build("https://mcp.example.com/mcp");
    const response = await handle(new Request("https://mcp.example.com/mcp", { method: "POST" }));
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${ROOT_PRM}/mcp"`);
  });

  it("serves one route for a resource without a path, and the challenge names it", async () => {
    const handle = build("https://mcp.example.com");
    expect((await handle(get(ROOT_PRM))).status).toBe(200);
    const response = await handle(new Request("https://mcp.example.com/mcp", { method: "POST" }));
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${ROOT_PRM}"`);
  });

  it("keeps the root route when metadata.path overrides the primary one", async () => {
    const handle = createMcpHandler({
      client: clientFor("https://mcp.example.com/mcp"),
      metadata: { path: "/prm.json" },
      handler: async () => new Response("ok"),
    });
    expect((await handle(get("https://mcp.example.com/prm.json"))).status).toBe(200);
    expect((await handle(get(ROOT_PRM))).status).toBe(200);
    expect((await handle(get(`${ROOT_PRM}/mcp`))).status).toBe(401);
    const challenge = await handle(new Request("https://mcp.example.com/mcp", { method: "POST" }));
    expect(challenge.headers.get("www-authenticate")).toContain('resource_metadata="https://mcp.example.com/prm.json"');
  });

  it("answers other methods on the root route with 405", async () => {
    const handle = build("https://mcp.example.com/mcp");
    const response = await handle(new Request(ROOT_PRM, { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

describe("resource versus audience", () => {
  const AUD = "https://mcp.example.com/mcp";

  it("accepts a resource equal to the audience", () => {
    expect(() => build(AUD, AUD)).not.toThrow();
  });

  it("rejects a resource that differs from the audience", () => {
    const error = capture(() => build(AUD, "https://other.example.com/mcp"));
    expect(error).toBeInstanceOf(InvalidConfigurationError);
    expect(error.message).not.toMatch(/trailing slash/);
    expect(error.message).toMatch(/Omit "resource" to use the audience\./);
  });

  it("accepts a difference in the case of the scheme and host only", () => {
    expect(() => build(AUD, "HTTPS://MCP.Example.COM/mcp")).not.toThrow();
  });

  it("rejects a difference in the case of the path", () => {
    expect(() => build(AUD, "https://mcp.example.com/MCP")).toThrow(InvalidConfigurationError);
  });

  it("rejects a trailing slash difference and says so", () => {
    for (const [audience, resource] of [
      [AUD, `${AUD}/`],
      [`${AUD}/`, AUD],
      ["https://mcp.example.com", "https://mcp.example.com/"],
    ] as const) {
      const error = capture(() => build(audience, resource));
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      expect(error.message).toMatch(/trailing slash/);
    }
  });

  it("keeps defaulting the resource from the audience when it is omitted", async () => {
    const handle = build(AUD);
    expect((await json(await handle(get(`${ROOT_PRM}/mcp`))))["resource"]).toBe(AUD);
  });

  it("applies the same rule in the SDK and Node handlers", () => {
    const createServer = () => ({ connect: async () => undefined, close: async () => undefined });
    expect(() =>
      createMcpSdkHandler({ client: clientFor(AUD), resource: "https://other.example.com/mcp", createServer }),
    ).toThrow(InvalidConfigurationError);
    expect(() =>
      createNodeMcpHandler({ client: clientFor(AUD), resource: "https://other.example.com/mcp", createServer }),
    ).toThrow(InvalidConfigurationError);
  });
});

describe("client configuration tiers", () => {
  const ENV = {
    AUTH0_DOMAIN: "tenant.example.com",
    AUTH0_AUDIENCE: "https://mcp.example.com/mcp",
    AUTH0_CLIENT_ID: "env-client",
    AUTH0_CLIENT_SECRET: "env-secret",
  };
  const createServer = () => ({ connect: async () => undefined, close: async () => undefined });
  const handlers = {
    createMcpHandler: (extra: object) => createMcpHandler({ handler: async () => new Response("ok"), ...extra }),
    createMcpSdkHandler: (extra: object) => createMcpSdkHandler({ createServer, ...extra }),
    createNodeMcpHandler: (extra: object) => createNodeMcpHandler({ createServer, ...extra }),
  };

  function setEnv(values: Record<string, string>) {
    for (const name of Object.keys(ENV)) vi.stubEnv(name, values[name] ?? "");
  }

  describe.each(Object.entries(handlers))("%s", (_name, make) => {
    it("accepts a client", () => {
      setEnv({});
      expect(() => make({ client: clientFor("https://mcp.example.com/mcp") })).not.toThrow();
    });

    it("builds the client from inline options", () => {
      setEnv({});
      expect(() => make({ domain: "tenant.example.com", audience: "https://mcp.example.com/mcp" })).not.toThrow();
    });

    it("builds the client from the environment when given neither", () => {
      setEnv(ENV);
      expect(() => make({})).not.toThrow();
    });

    it("lets inline options win over and fill gaps from the environment", () => {
      setEnv({ AUTH0_DOMAIN: "tenant.example.com" });
      expect(() => make({ audience: "https://mcp.example.com/mcp" })).not.toThrow();
    });

    it("rejects a client combined with inline client options", () => {
      setEnv(ENV);
      const error = capture(() => make({ client: clientFor("https://mcp.example.com/mcp"), clientId: "x", domain: "d" }));
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      expect(error.message).toContain('"clientId"');
      expect(error.message).toContain('"domain"');
    });

    it("names the missing option and variable, not any value", () => {
      setEnv({ AUTH0_AUDIENCE: "https://secret-audience.example.com/mcp" });
      const error = capture(() => make({}));
      expect(error).toBeInstanceOf(InvalidConfigurationError);
      expect(error.message).toContain("AUTH0_DOMAIN");
      expect(error.message).not.toContain("secret-audience");
      setEnv({ AUTH0_DOMAIN: "secret-tenant.example.com" });
      const second = capture(() => make({}));
      expect(second.message).toContain("AUTH0_AUDIENCE");
      expect(second.message).not.toContain("secret-tenant");
    });
  });

  it("serves requests with a client built from the environment", async () => {
    setEnv(ENV);
    server.use(...tenant.handlers);
    const handle = handlers.createMcpHandler({});
    const accessToken = await mintAccessToken(key, {
      iss: tenant.issuer,
      aud: ENV.AUTH0_AUDIENCE,
      sub: "user|1",
      scope: "read",
    });
    const response = await handle(
      new Request("https://mcp.example.com/mcp", { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }),
    );
    expect(response.status).toBe(200);
  });

  it("passes inline options such as tokenStore and requestTimeoutMs to the client", () => {
    setEnv({});
    expect(() =>
      handlers.createMcpHandler({
        domain: "tenant.example.com",
        audience: "https://mcp.example.com/mcp",
        requestTimeoutMs: -1,
      }),
    ).toThrow(InvalidConfigurationError);
  });
});

function capture(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}
