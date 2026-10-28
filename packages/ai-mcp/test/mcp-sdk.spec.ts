import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setupServer } from "msw/node";
import * as z from "zod";
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth as requireBearerAuthGate,
} from "@modelcontextprotocol/server";
import type { AuthInfo as SdkAuthInfo } from "@modelcontextprotocol/server";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import {
  AuthError,
  InvalidConfigurationError,
  VerifyAccessTokenError,
} from "@auth0/auth0-api-js";
import { createMcpClient } from "../src/client.js";
import type { McpClient } from "../src/client.js";
import type { AuthInfo, McpHandlerBaseOptions } from "../src/handler.js";
import {
  asTokenVerifier,
  createMcpSdkHandler,
  createNodeMcpHandler,
  toNodeHandler,
} from "../src/mcp-sdk.js";
import type { McpSdkHandlerOptions } from "../src/mcp-sdk.js";
import { getCallerMcpClient, getCallerPrincipal } from "../src/request-context.js";
import { withRequiredScopes } from "../src/scopes.js";
import {
  createAuth0Handlers,
  createTestKey,
  mintAccessToken,
  scopeMode,
} from "./support/index.js";
import type { TestKey } from "./support/index.js";

// The wrapper's AuthInfo must stay assignable to the SDK's AuthInfo.
const assertAssignable = (value: AuthInfo): SdkAuthInfo => value;
void assertAssignable;

const ORIGIN = "https://mcp.example.com";
const AUDIENCE = ORIGIN;
const ENDPOINT = `${ORIGIN}/mcp`;
const DOWNSTREAM = "https://api.example.com";

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  tenant = createAuth0Handlers({ key, scope: scopeMode.echo });
  server.listen({
    onUnhandledRequest(request, print) {
      if (new URL(request.url).hostname === "127.0.0.1") return;
      print.error();
    },
  });
});
afterEach(() => {
  server.resetHandlers();
  tenant.state.reset();
});
afterAll(() => server.close());

function useTenant() {
  server.use(...tenant.handlers);
}

function makeClient(
  overrides: Partial<Parameters<typeof createMcpClient>[0]> = {},
): McpClient {
  return createMcpClient({
    domain: "tenant.example.com",
    audience: AUDIENCE,
    clientId: "mcp-client",
    clientSecret: "secret",
    ...overrides,
  });
}

function token(scope = "read write", extra: Parameters<typeof mintAccessToken>[1] = {}) {
  return mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: "user|1",
    scope,
    claims: { client_id: "client-a" },
    ...extra,
  });
}

interface Seen {
  authInfo?: Record<string, unknown>;
  contextSub?: string;
  hasClient?: boolean;
}

function buildMcpServer(seen: Seen[]): McpServer {
  const mcp = new McpServer({ name: "test", version: "1.0.0" });
  mcp.registerTool("whoami", { description: "Reports the caller." }, async (ctx) => {
    const info = ctx.http?.authInfo;
    seen.push({
      authInfo: info as unknown as Record<string, unknown>,
      contextSub: getCallerPrincipal()?.sub,
      hasClient: getCallerMcpClient() !== undefined,
    });
    return { content: [{ type: "text", text: "ok" }] };
  });
  mcp.registerTool(
    "delegate",
    { description: "Exchanges the caller token." },
    async () => {
      const result = await getCallerMcpClient()!.getTokenOnBehalfOf({
        audience: DOWNSTREAM,
        scope: "api:read",
      });
      return { content: [{ type: "text", text: result.grantedScopes.join(" ") }] };
    },
  );
  mcp.registerTool(
    "admin",
    { description: "Needs an extra scope." },
    withRequiredScopes("admin", async () => ({
      content: [{ type: "text" as const, text: "secret" }],
    })),
  );
  return mcp;
}

function toolCall(name: string, headers: Record<string, string> = {}, url = ENDPOINT) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
}

type SdkOverrides = Partial<Omit<McpHandlerBaseOptions, "handler">> & {
  client?: McpClient;
  createServer?: McpSdkHandlerOptions["createServer"];
};

function makeHandler(seen: Seen[], overrides: SdkOverrides = {}) {
  return createMcpSdkHandler({
    client: makeClient(),
    resource: AUDIENCE,
    authorizationServers: [tenant.issuer],
    createServer: () => buildMcpServer(seen),
    ...overrides,
  });
}

interface ToolResult {
  result?: { isError?: boolean; content: Array<{ text: string }> };
}

describe("createMcpSdkHandler", () => {
  it("gives tools the verified caller as authInfo and as request context", async () => {
    useTenant();
    const seen: Seen[] = [];
    const response = await makeHandler(seen)(
      toolCall("whoami", { authorization: `Bearer ${await token()}` }),
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authInfo).toMatchObject({
      clientId: "client-a",
      scopes: ["read", "write"],
      extra: { sub: "user|1" },
    });
    expect(seen[0]!.authInfo!.token).toBe("");
    expect(seen[0]!.contextSub).toBe("user|1");
    expect(seen[0]!.hasClient).toBe(true);
  });

  it("answers 405 with Allow: POST for GET and DELETE on the MCP path", async () => {
    useTenant();
    const factory = vi.fn(() => buildMcpServer([]));
    const handle = makeHandler([], { createServer: factory });
    for (const method of ["GET", "DELETE"]) {
      const response = await handle(
        new Request(ENDPOINT, {
          method,
          headers: { authorization: `Bearer ${await token()}`, accept: "text/event-stream" },
        }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("still serves the metadata document with GET", async () => {
    useTenant();
    const response = await makeHandler([])(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
    );
    expect(response.status).toBe(200);
  });

  it("surfaces a downscoped exchange inside a tool as an isError result with HTTP 200", async () => {
    useTenant();
    tenant.state.scope = scopeMode.fixed("other:scope");
    const response = await makeHandler([])(
      toolCall("delegate", { authorization: `Bearer ${await token()}` }),
    );
    const body = (await response.json()) as ToolResult;

    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).not.toContain("api:read");
  });

  it("lets a tool exchange the caller's token through the request-scoped client", async () => {
    useTenant();
    const response = await makeHandler([])(
      toolCall("delegate", { authorization: `Bearer ${await token()}` }),
    );
    const body = (await response.json()) as ToolResult;

    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.content[0]?.text).toBe("api:read");
    expect(tenant.state.successfulExchangeCount).toBe(1);
  });

  it("keeps concurrent callers apart", async () => {
    useTenant();
    const seen: Seen[] = [];
    const handle = makeHandler(seen);
    const [a, b] = await Promise.all([
      mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: "alice", scope: "read", claims: { client_id: "c" } }),
      mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: "bob", scope: "read", claims: { client_id: "c" } }),
    ]);
    await Promise.all([
      handle(toolCall("whoami", { authorization: `Bearer ${a}` })),
      handle(toolCall("whoami", { authorization: `Bearer ${b}` })),
    ]);

    expect(seen.map((entry) => entry.contextSub).sort()).toEqual(["alice", "bob"]);
  });

  it("answers 401 without a credential and never runs the server", async () => {
    useTenant();
    const seen: Seen[] = [];
    const factory = vi.fn(() => buildMcpServer(seen));
    const response = await makeHandler(seen, { createServer: factory })(toolCall("whoami"));

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate")!;
    expect(challenge).toContain(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
    expect(challenge).not.toContain("error=");
    expect(factory).not.toHaveBeenCalled();
  });

  it("answers 401 invalid_token for a bad token", async () => {
    useTenant();
    const response = await makeHandler([])(
      toolCall("whoami", { authorization: "Bearer not-a.valid.token" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("answers 403 insufficient_scope for a missing server-wide scope", async () => {
    useTenant();
    const factory = vi.fn(() => buildMcpServer([]));
    const response = await makeHandler([], {
      requiredScopes: ["read", "admin"],
      createServer: factory,
    })(toolCall("whoami", { authorization: `Bearer ${await token("read")}` }));

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="admin"');
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns an isError tool result with HTTP 200 for a per-tool scope denial", async () => {
    useTenant();
    const response = await makeHandler([])(
      toolCall("admin", { authorization: `Bearer ${await token("read")}` }),
    );
    const body = (await response.json()) as ToolResult;

    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toBe("Missing one or more required scopes.");
  });

  it("runs the tool when the per-tool scope is held", async () => {
    useTenant();
    const response = await makeHandler([])(
      toolCall("admin", { authorization: `Bearer ${await token("read admin")}` }),
    );
    const body = (await response.json()) as ToolResult;

    expect(body.result?.content[0]?.text).toBe("secret");
  });

  it("passes validated tool arguments and the caller context to a tool with an input schema", async () => {
    useTenant();
    const handle = makeHandler([], {
      createServer: () => {
        const mcp = new McpServer({ name: "test", version: "1.0.0" });
        mcp.registerTool(
          "echo",
          { description: "Echoes.", inputSchema: z.object({ text: z.string() }) },
          async ({ text }, ctx) => ({
            content: [{ type: "text" as const, text: `${text}:${ctx.http?.authInfo?.clientId}` }],
          }),
        );
        return mcp;
      },
    });
    const response = await handle(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${await token()}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "hi" } },
        }),
      }),
    );
    const body = (await response.json()) as ToolResult;

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.result?.content[0]?.text).toBe("hi:client-a");
  });

  it("answers an unknown tool with a JSON-RPC error, not a tool result", async () => {
    useTenant();
    const response = await makeHandler([])(
      toolCall("nope", { authorization: `Bearer ${await token()}` }),
    );
    const body = (await response.json()) as { error?: { code: number }; result?: unknown };

    expect(response.status).toBe(200);
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
  });

  it("answers with a JSON body and no session id", async () => {
    useTenant();
    const response = await makeHandler([])(
      toolCall("whoami", { authorization: `Bearer ${await token()}` }),
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("closes the server after each request", async () => {
    useTenant();
    const close = vi.fn(async () => undefined);
    const handle = makeHandler([], {
      createServer: () => {
        const mcp = buildMcpServer([]);
        const original = mcp.close.bind(mcp);
        mcp.close = async () => {
          close();
          return original();
        };
        return mcp;
      },
    });
    await handle(toolCall("whoami", { authorization: `Bearer ${await token()}` }));

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("Node adapter", () => {
  let http: HttpServer | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
    http = undefined;
  });

  async function listen(listener: Parameters<typeof createServer>[1]): Promise<string> {
    http = createServer(listener);
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  }

  const rpc = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "whoami", arguments: {} },
  });
  const jsonHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  it("serves an authenticated tool call over real HTTP", async () => {
    useTenant();
    const seen: Seen[] = [];
    const url = await listen(
      createNodeMcpHandler({
        client: makeClient(),
        resource: AUDIENCE,
        authorizationServers: [tenant.issuer],
        createServer: () => buildMcpServer(seen),
      }),
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${await token()}` },
      body: rpc,
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as ToolResult).result?.content[0]?.text).toBe("ok");
    expect(seen[0]!.contextSub).toBe("user|1");
  });

  it("passes Authorization and DPoP headers through unchanged", async () => {
    const received: Array<Record<string, string | null>> = [];
    const url = await listen(
      toNodeHandler(
        async (request) => {
          received.push({
            authorization: request.headers.get("authorization"),
            dpop: request.headers.get("dpop"),
            url: request.url,
            method: request.method,
          });
          return new Response("done", { status: 200 });
        },
        { resource: AUDIENCE },
      ),
    );
    await fetch(url, {
      method: "POST",
      headers: { authorization: "DPoP abc", dpop: "a.b.c" },
      body: "{}",
    });

    expect(received).toEqual([
      { authorization: "DPoP abc", dpop: "a.b.c", url: ENDPOINT, method: "POST" },
    ]);
  });

  it("builds the request URL from the configured resource, not the Host header", async () => {
    let seenUrl = "";
    const url = await listen(
      toNodeHandler(
        async (request) => {
          seenUrl = request.url;
          return new Response(null, { status: 204 });
        },
        { resource: AUDIENCE },
      ),
    );
    const response = await fetch(`${url}?x=1`, { headers: { host: "evil.example.net" } });

    expect(response.status).toBe(204);
    expect(seenUrl).toBe(`${ENDPOINT}?x=1`);
  });

  it("answers 401 with the challenge header over real HTTP", async () => {
    useTenant();
    const url = await listen(
      createNodeMcpHandler({
        client: makeClient(),
        resource: AUDIENCE,
        authorizationServers: [tenant.issuer],
        createServer: () => buildMcpServer([]),
      }),
    );
    const response = await fetch(url, { method: "POST", headers: jsonHeaders, body: rpc });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("serves a tool call when only client and createServer are given", async () => {
    useTenant();
    const seen: Seen[] = [];
    const url = await listen(
      createNodeMcpHandler({
        client: makeClient(),
        createServer: () => buildMcpServer(seen),
      }),
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${await token()}` },
      body: rpc,
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("answers 401 with a challenge that points at the defaulted metadata url", async () => {
    useTenant();
    const url = await listen(
      createNodeMcpHandler({
        client: makeClient(),
        createServer: () => buildMcpServer([]),
      }),
    );
    const response = await fetch(url, { method: "POST", headers: jsonHeaders, body: rpc });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
  });

  it("uses an explicit resource equal to the audience for the adapter origin", async () => {
    useTenant();
    const url = await listen(
      createNodeMcpHandler({
        client: makeClient({ audience: ENDPOINT }),
        resource: ENDPOINT,
        createServer: () => buildMcpServer([]),
      }),
    );
    const response = await fetch(url, { method: "POST", headers: jsonHeaders, body: rpc });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("throws at construction when a default cannot be derived", () => {
    expect(() =>
      createNodeMcpHandler({
        client: makeClient({ audience: "my-mcp-server" }),
        createServer: () => buildMcpServer([]),
      }),
    ).toThrow(/"resource" is required/);
    expect(() =>
      createMcpSdkHandler({
        client: { ...makeClient(), domain: undefined },
        resource: AUDIENCE,
        createServer: () => buildMcpServer([]),
      }),
    ).toThrow(/"authorizationServers" is required/);
  });

  it("rejects a body over the limit with 413 and does not call the handler", async () => {
    const handle = vi.fn(async () => new Response("x"));
    const url = await listen(toNodeHandler(handle, { resource: AUDIENCE, maxBodyBytes: 16 }));
    const response = await fetch(url, { method: "POST", body: "x".repeat(64) });

    expect(response.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "The request body is too large.",
    });
  });

  it("enforces the limit on chunked bodies that declare no length", async () => {
    const handle = vi.fn(async () => new Response("x"));
    const url = await listen(toNodeHandler(handle, { resource: AUDIENCE, maxBodyBytes: 16 }));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(10)));
        controller.enqueue(new TextEncoder().encode("x".repeat(10)));
        controller.close();
      },
    });
    const response = await fetch(url, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  function rawRequest(url: string, lines: string[]): Promise<string> {
    const { hostname, port } = new URL(url);
    return new Promise((resolve) => {
      const socket = connect(Number(port), hostname, () => socket.write(lines.join("\r\n") + "\r\n\r\n"));
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
    });
  }

  it("rejects a malformed Content-Length with 400", async () => {
    const handle = vi.fn(async () => new Response("x"));
    const url = await listen(toNodeHandler(handle, { resource: AUDIENCE }));
    for (const length of ["abc", "-5", "1.5", "1e3"]) {
      const reply = await rawRequest(url, [
        "POST /mcp HTTP/1.1", "Host: x", "Connection: close", `Content-Length: ${length}`,
      ]);
      // Node's own parser may refuse these before the adapter sees them.
      expect(reply).not.toContain("HTTP/1.1 200");
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a malformed Content-Length reaching the adapter with 400", async () => {
    const handle = vi.fn(async () => new Response("x"));
    const adapter = toNodeHandler(handle, { resource: AUDIENCE });
    const url = await listen((req, res) => {
      req.headers["content-length"] = "-5";
      return adapter(req, res);
    });
    const response = await fetch(url, { method: "POST", body: "{}" });

    expect(response.status).toBe(400);
    expect(response.headers.get("connection")).toBe("close");
    expect(handle).not.toHaveBeenCalled();
  });

  it("closes the connection after a 413", async () => {
    const url = await listen(toNodeHandler(async () => new Response("x"), { resource: AUDIENCE, maxBodyBytes: 4 }));
    const response = await fetch(url, { method: "POST", body: "x".repeat(64) });

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
  });

  it("does not let a // path change the origin", async () => {
    const handle = vi.fn(async () => new Response("x"));
    const adapter = toNodeHandler(handle, { resource: AUDIENCE });
    const url = await listen((req, res) => {
      req.url = "//evil.example/x";
      return adapter(req, res);
    });
    const response = await fetch(url);

    expect(response.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects paths that are not a single-slash path", async () => {
    const handle = vi.fn(async () => new Response("x"));
    const adapter = toNodeHandler(handle, { resource: AUDIENCE });
    for (const bad of ["http://evil.example/x", "/\\evil.example", "mcp"]) {
      const url = await listen((req, res) => {
        req.url = bad;
        return adapter(req, res);
      });
      expect((await fetch(url)).status).toBe(400);
      await new Promise<void>((resolve) => http!.close(() => resolve()));
    }
    expect(handle).not.toHaveBeenCalled();
    http = undefined;
  });

  it("never reaches the handler with two Authorization headers merged into a valid one", async () => {
    const seen: Array<string | null> = [];
    const url = await listen(
      toNodeHandler(
        async (request) => {
          seen.push(request.headers.get("authorization"));
          return new Response("ok");
        },
        { resource: AUDIENCE },
      ),
    );
    await rawRequest(url, [
      "GET /mcp HTTP/1.1", "Host: x", "Connection: close",
      "Authorization: Bearer first", "Authorization: Bearer second",
    ]);

    expect(seen).toEqual(["Bearer first"]);
  });

  it("joins a string[] header value into repeated header entries", async () => {
    const seen: Array<string | null> = [];
    const adapter = toNodeHandler(
      async (request) => {
        seen.push(request.headers.get("x-multi"));
        return new Response("ok");
      },
      { resource: AUDIENCE },
    );
    const url = await listen((req, res) => {
      req.headers["x-multi"] = ["a", "b"];
      return adapter(req, res);
    });
    await fetch(url);

    expect(seen).toEqual(["a, b"]);
  });

  it("drops the handler's headers when the body stream fails before the first write", async () => {
    const url = await listen(
      toNodeHandler(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("boom"));
              },
            }),
            {
              status: 200,
              headers: { "set-cookie": "a=b", "www-authenticate": "Bearer x", "content-length": "99" },
            },
          ),
        { resource: AUDIENCE },
      ),
    );
    const response = await fetch(url);

    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: "server_error",
      error_description: "Internal server error.",
    });
  });

  it("cancels a stalled stream when the client aborts", async () => {
    let cancelled = false;
    const url = await listen(
      toNodeHandler(
        async () =>
          new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => undefined),
              cancel() {
                cancelled = true;
              },
            }),
          ),
        { resource: AUDIENCE },
      ),
    );
    const controller = new AbortController();
    const pending = fetch(url, { signal: controller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("treats an empty parser-default body as no body", async () => {
    const received: Array<string | null> = [];
    const adapter = toNodeHandler(
      async (request) => {
        received.push(request.body === null ? null : await request.text());
        return new Response("ok");
      },
      { resource: AUDIENCE },
    );
    const url = await listen((req, res) => {
      (req as unknown as { body: unknown }).body = {};
      return adapter(req, res);
    });
    await fetch(url, { method: "POST" });

    expect(received).toEqual([null]);
  });

  it("handles a pre-parsed Buffer, Uint8Array and string body and limits each", async () => {
    const received: string[] = [];
    const adapter = toNodeHandler(
      async (request) => {
        received.push(await request.text());
        return new Response("ok");
      },
      { resource: AUDIENCE, maxBodyBytes: 8 },
    );
    const bodies: unknown[] = [Buffer.from("buf"), new TextEncoder().encode("u8"), "str", { a: 1 }];
    let index = 0;
    const url = await listen((req, res) => {
      (req as unknown as { body: unknown }).body = bodies[index++];
      return adapter(req, res);
    });
    for (let i = 0; i < bodies.length; i++) await fetch(url, { method: "POST", body: "{}" });

    expect(received).toEqual(["buf", "u8", "str", '{"a":1}']);

    bodies.push(Buffer.from("x".repeat(64)));
    const big = await fetch(url, { method: "POST", body: "{}" });
    expect(big.status).toBe(413);
  });

  it("stops reading the response when the client goes away", async () => {
    let cancelled = false;
    const url = await listen(
      toNodeHandler(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(65536));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
        { resource: AUDIENCE },
      ),
    );
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("turns a thrown error into a generic 500", async () => {
    const url = await listen(
      toNodeHandler(
        async () => {
          throw new Error("secret detail");
        },
        { resource: AUDIENCE },
      ),
    );
    const response = await fetch(url);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret detail");
    expect(JSON.parse(text)).toEqual({
      error: "server_error",
      error_description: "Internal server error.",
    });
  });

  it("re-serializes a body a parser already consumed", async () => {
    let received = "";
    const handler = toNodeHandler(
      async (request) => {
        received = await request.text();
        return new Response("ok");
      },
      { resource: AUDIENCE },
    );
    const url = await listen((req, res) => {
      (req as unknown as { body: unknown }).body = { hello: "world" };
      return handler(req, res);
    });
    await fetch(url, { method: "POST", body: "ignored" });

    expect(received).toBe('{"hello":"world"}');
  });

  it("uses originalUrl when a framework rewrote the path", async () => {
    let seenUrl = "";
    const handler = toNodeHandler(
      async (request) => {
        seenUrl = request.url;
        return new Response(null, { status: 204 });
      },
      { resource: AUDIENCE },
    );
    const url = await listen((req, res) => {
      (req as unknown as { originalUrl: string }).originalUrl = "/mcp";
      req.url = "/";
      return handler(req, res);
    });
    await fetch(url);

    expect(seenUrl).toBe(ENDPOINT);
  });

  it("forwards repeated headers and streams bodies", async () => {
    const url = await listen(
      toNodeHandler(
        async (request) => {
          const headers = new Headers({ "x-seen": request.headers.get("x-multi") ?? "" });
          return new Response("hello", { status: 200, headers });
        },
        { resource: AUDIENCE },
      ),
    );
    const response = await fetch(url, { headers: { "x-multi": "a" } });

    expect(response.headers.get("x-seen")).toBe("a");
    expect(await response.text()).toBe("hello");
  });
});

describe("asTokenVerifier", () => {
  interface FakeRes {
    statusCode?: number;
    headers: Record<string, string>;
    body?: unknown;
    set(name: string, value: string): FakeRes;
    status(code: number): FakeRes;
    json(value: unknown): FakeRes;
  }

  async function run(authorization: string | undefined, client: McpClient, requiredScopes?: string[]) {
    const res: FakeRes = {
      headers: {},
      set(name, value) {
        this.headers[name] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    };
    const req = { headers: authorization === undefined ? {} : { authorization } } as {
      headers: Record<string, string>;
      auth?: SdkAuthInfo;
    };
    const next = vi.fn();
    const middleware = requireBearerAuth({
      verifier: asTokenVerifier(client),
      requiredScopes,
    });
    await middleware(req as never, res as never, next);
    return { req, res, next };
  }

  it("accepts a valid token and exposes the caller as AuthInfo", async () => {
    useTenant();
    const { req, res, next } = await run(`Bearer ${await token()}`, makeClient());

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
    expect(req.auth).toMatchObject({
      clientId: "client-a",
      scopes: ["read", "write"],
      extra: { sub: "user|1" },
    });
    expect(req.auth!.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("carries the organization when the token has one", async () => {
    useTenant();
    const bearer = await token("read", { claims: { client_id: "c", org_id: "org_1" } });
    const { req } = await run(`Bearer ${bearer}`, makeClient());

    expect(req.auth!.extra).toMatchObject({ orgId: "org_1" });
  });

  it("maps an invalid token to the SDK invalid_token response with a generic message", async () => {
    useTenant();
    const { res, next } = await run("Bearer garbage.token.value", makeClient());

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      error: "invalid_token",
      error_description: "Invalid access token.",
    });
  });

  it("maps an expired token to invalid_token", async () => {
    useTenant();
    const expired = await token("read", { exp: Math.floor(Date.now() / 1000) - 3600 });
    const { res } = await run(`Bearer ${expired}`, makeClient());

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: "invalid_token" });
  });

  it("maps a missing server-wide scope to insufficient_scope", async () => {
    useTenant();
    const { res, next } = await run(`Bearer ${await token("read")}`, makeClient(), ["admin"]);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "insufficient_scope" });
  });

  it("does not pass the original verifier message through", async () => {
    const client = makeClient();
    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(
      new VerifyAccessTokenError("leaky internal detail"),
    );
    const verifier = asTokenVerifier(client);

    const error = await verifier.verifyAccessToken("t").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
    expect((error as Error).message).toBe("Invalid access token.");
  });

  it("maps a core 403 to the SDK insufficient scope error", async () => {
    const client = makeClient();
    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(
      new AuthError("detail", "insufficient_scope", 403),
    );

    const error = await asTokenVerifier(client)
      .verifyAccessToken("t")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe(OAuthErrorCode.InsufficientScope);
    expect((error as Error).message).toBe("Insufficient scope.");
  });

  it("maps a core error without a status to invalid_token", async () => {
    const client = makeClient();
    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(new AuthError("x", "x"));

    const error = await asTokenVerifier(client)
      .verifyAccessToken("t")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
  });

  it("rethrows server-side failures so the middleware answers 500", async () => {
    const client = makeClient();
    const failure = new AuthError("down", "server_error", 503);
    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(failure);
    const unexpected = new InvalidConfigurationError("x");
    const verifier = asTokenVerifier(client);

    await expect(verifier.verifyAccessToken("t")).rejects.toBe(failure);

    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(unexpected);
    await expect(verifier.verifyAccessToken("t")).rejects.toBe(unexpected);
  });

  it("maps a non-core error thrown while verifying to a rethrow", async () => {
    const client = makeClient();
    const boom = new TypeError("boom");
    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(boom);

    await expect(asTokenVerifier(client).verifyAccessToken("t")).rejects.toBe(boom);
  });

  it("answers a verifier failure that is not an auth error with a generic 500 body", async () => {
    const client = makeClient();
    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(new TypeError("db password leaked"));
    const { res, next } = await run("Bearer abc", client);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("leaked");
    expect(res.body).toMatchObject({ error: "server_error" });
  });

  it("answers a core 5xx with a generic 500 body", async () => {
    const client = makeClient();
    vi.spyOn(client, "verifyAccessToken").mockRejectedValue(new AuthError("jwks host down", "x", 503));
    const { res } = await run("Bearer abc", client);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("jwks");
  });

  describe("with the web standard requireBearerAuth gate", () => {
    const gateRequest = (authorization?: string) =>
      new Request(ENDPOINT, {
        method: "POST",
        headers: authorization === undefined ? {} : { authorization },
      });

    it("lets a valid token through with the v2 AuthInfo shape", async () => {
      useTenant();
      const gate = requireBearerAuthGate({ verifier: asTokenVerifier(makeClient()) });
      const result = await gate(gateRequest(`Bearer ${await token()}`));

      expect(result).not.toBeInstanceOf(Response);
      expect(result).toMatchObject({
        token: "",
        clientId: "client-a",
        scopes: ["read", "write"],
        extra: { sub: "user|1" },
      });
    });

    // The v2 middleware maps only its own OAuthError to 401 and 403. A verifier that
    // throws any other error type makes an invalid token a 500, so these tests pin
    // the error type the adapter throws against the real middleware.
    it("answers 401 invalid_token for a bad token, not 500", async () => {
      useTenant();
      const gate = requireBearerAuthGate({ verifier: asTokenVerifier(makeClient()) });
      const result = (await gate(gateRequest("Bearer garbage.token.value"))) as Response;

      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(401);
      expect(result.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(await result.json()).toMatchObject({ error: "invalid_token" });
    });

    it("answers 403 insufficient_scope for a missing scope, not 500", async () => {
      useTenant();
      const gate = requireBearerAuthGate({
        verifier: asTokenVerifier(makeClient()),
        requiredScopes: ["admin"],
      });
      const result = (await gate(gateRequest(`Bearer ${await token("read")}`))) as Response;

      expect(result.status).toBe(403);
      expect(result.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    });

    it("answers 403 when the core reports insufficient scope", async () => {
      const client = makeClient();
      vi.spyOn(client, "verifyAccessToken").mockRejectedValue(
        new AuthError("detail", "insufficient_scope", 403),
      );
      const gate = requireBearerAuthGate({ verifier: asTokenVerifier(client) });
      const result = (await gate(gateRequest("Bearer abc"))) as Response;

      expect(result.status).toBe(403);
    });

    it("shows that a verifier throwing a generic error turns an invalid token into 500", async () => {
      const gate = requireBearerAuthGate({
        verifier: {
          verifyAccessToken: async () => {
            throw new Error("Invalid access token.");
          },
        },
      });
      const result = (await gate(gateRequest("Bearer abc"))) as Response;

      expect(result.status).toBe(500);
    });

    it("answers a core 5xx with a generic 500 body", async () => {
      const client = makeClient();
      vi.spyOn(client, "verifyAccessToken").mockRejectedValue(
        new AuthError("jwks host down", "x", 503),
      );
      const gate = requireBearerAuthGate({ verifier: asTokenVerifier(client) });
      const result = (await gate(gateRequest("Bearer abc"))) as Response;

      expect(result.status).toBe(500);
      expect(await result.text()).not.toContain("jwks");
    });
  });

  it("leaves the request context empty inside requireBearerAuth routes", async () => {
    useTenant();
    await run(`Bearer ${await token()}`, makeClient());

    expect(getCallerPrincipal()).toBeUndefined();
  });
});
