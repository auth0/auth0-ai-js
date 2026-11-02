import type { IncomingMessage } from "node:http";
import { InvalidConfigurationError } from "@auth0/ai-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFastMcpAuth } from "../src/create.js";
import { defaultEndpoint } from "../src/options.js";
import type { FastMcpAuthOptions } from "../src/options.js";
import { fakeRequest, stubClient, thrown, withEnv } from "./support/stubs.js";

function setup(audience: string, options: Partial<FastMcpAuthOptions> = {}) {
  return createFastMcpAuth({ client: stubClient({ audience }), ...options } as FastMcpAuthOptions);
}

describe("createFastMcpAuth with no argument", () => {
  const ENV = {
    AUTH0_DOMAIN: "env-tenant.example.com",
    AUTH0_AUDIENCE: "https://env.example.com/mcp",
    AUTH0_CLIENT_ID: "env-client",
    AUTH0_CLIENT_SECRET: "env-secret",
  };

  it("reads the client from the environment like createFastMcpAuth({})", async () => {
    const [bare, empty] = await withEnv(ENV, () => [createFastMcpAuth(), createFastMcpAuth({})] as const);
    expect(bare.oauth.protectedResource).toEqual(empty.oauth.protectedResource);
    expect(bare.oauth.protectedResource.resource).toBe(ENV.AUTH0_AUDIENCE);
    expect(bare.endpoint).toBe("/mcp");
  });

  it("fails with the configuration error, not a TypeError, when the environment is empty", async () => {
    const empty = { AUTH0_DOMAIN: undefined, AUTH0_AUDIENCE: undefined, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: undefined };
    const error = await thrown(withEnv(empty, () => createFastMcpAuth()));
    expect(error).toBeInstanceOf(InvalidConfigurationError);
  });
});

describe("trailing slash on the audience path", () => {
  it.each(["https://mcp.example.com/mcp/", "https://mcp.example.com/api/mcp/"])(
    "refuses %s at startup and names the audience without the slash",
    (audience) => {
      const attempt = () => setup(audience);
      expect(attempt).toThrow(InvalidConfigurationError);
      expect(attempt).toThrow(/ends with a slash/);
      expect(attempt).toThrow(new RegExp(`audience without the trailing slash \\("${audience.slice(0, -1).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\)`));
    },
  );

  it("refuses it when an explicit endpoint is also given", () => {
    expect(() => setup("https://mcp.example.com/mcp/", { endpoint: "/mcp" })).toThrow(/ends with a slash/);
  });

  it.each(["https://mcp.example.com", "https://mcp.example.com/"])("keeps the origin-only audience %s valid", (audience) => {
    expect(() => setup(audience)).not.toThrow();
    expect(setup(audience).endpoint).toBe("/mcp");
  });
});

describe("default endpoint", () => {
  it("is the path of the audience when it has one", () => {
    expect(setup("https://mcp.example.com/orders").endpoint).toBe("/orders");
    expect(setup("https://mcp.example.com/api/mcp").endpoint).toBe("/api/mcp");
  });

  it("is /mcp for an audience without a path", () => {
    expect(setup("https://mcp.example.com").endpoint).toBe("/mcp");
  });

  it("serves the metadata of an audience with another path at the matching route", async () => {
    const response = (await thrown(setup("https://mcp.example.com/orders").authenticate(fakeRequest({}, "/orders")))) as Response;
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/orders"',
    );
  });

  it("takes an explicit endpoint, and keeps the error when it differs from the audience path", () => {
    expect(setup("https://mcp.example.com/orders", { endpoint: "/orders" }).endpoint).toBe("/orders");
    expect(() => setup("https://mcp.example.com/orders", { endpoint: "/mcp" })).toThrow(/must equal "endpoint"/);
  });

  it("rejects an audience path that cannot be an endpoint", () => {
    expect(() => setup("https://mcp.example.com//x")).toThrow(InvalidConfigurationError);
  });

  it("derives the endpoint from a resource string", () => {
    expect(defaultEndpoint("https://mcp.example.com/a/b")).toBe("/a/b");
    expect(defaultEndpoint("https://mcp.example.com/")).toBe("/mcp");
  });
});

describe("the endpoint property", () => {
  it("is not enumerable, so spreading the result passes no unknown key to FastMCP", () => {
    const auth = setup("https://mcp.example.com/orders");
    expect(Object.keys(auth).sort()).toEqual(["authenticate", "oauth"]);
    expect(Object.keys({ ...auth }).sort()).toEqual(["authenticate", "oauth"]);
    expect(JSON.stringify(Object.keys({ ...auth }))).not.toContain("endpoint");
    expect(auth.endpoint).toBe("/orders");
  });

  it("is read only", () => {
    const auth = setup("https://mcp.example.com/orders");
    expect(() => {
      (auth as { endpoint: string }).endpoint = "/other";
    }).toThrow(TypeError);
    expect(auth.endpoint).toBe("/orders");
    expect(Object.getOwnPropertyDescriptor(auth, "endpoint")).toMatchObject({
      enumerable: false,
      writable: false,
      configurable: false,
    });
  });
});

describe("warning for a request on another path", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  async function request(auth: ReturnType<typeof setup>, url: string): Promise<Response> {
    return (await thrown(auth.authenticate(fakeRequest({}, url)))) as Response;
  }

  it("names the path that arrived and the configured endpoint, once per distinct path", async () => {
    const auth = setup("https://mcp.example.com/mcp");
    await request(auth, "/warn-once-a");
    await request(auth, "/warn-once-a");
    await request(auth, "/warn-once-a");
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain('"/warn-once-a"');
    expect(text).toContain('"/mcp"');
    expect(text).toContain("auth.endpoint");
    await request(auth, "/warn-once-b");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not log the query string", async () => {
    const auth = setup("https://mcp.example.com/mcp");
    await request(auth, "/warn-query?token=abc123&x=1");
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain("/warn-query");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("token=");
  });

  it("stays quiet for the endpoint, the metadata routes and the legacy SSE routes", async () => {
    const auth = setup("https://mcp.example.com/mcp");
    for (const url of [
      "/mcp",
      "/mcp?x=1",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/sse",
      "/messages?sessionId=1",
    ]) {
      await request(auth, url);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not change the response", async () => {
    const auth = setup("https://mcp.example.com/mcp");
    const onPath = await request(auth, "/mcp");
    const offPath = await request(auth, "/warn-same-response");
    expect(offPath.status).toBe(onPath.status);
    expect(offPath.headers.get("www-authenticate")).toBe(onPath.headers.get("www-authenticate"));
    expect(await offPath.text()).toBe(await onPath.text());
  });

  it("ignores a request without a usable url", async () => {
    const auth = setup("https://mcp.example.com/mcp");
    const noUrl = { headers: {}, method: "POST" } as unknown as IncomingMessage;
    expect(await thrown(auth.authenticate(noUrl))).toBeInstanceOf(Response);
    await request(auth, "http://[bad");
    expect(warn).not.toHaveBeenCalled();
  });
});
