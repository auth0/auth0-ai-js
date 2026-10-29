/**
 * Shared rig for the integration suites. Every test drives a real MCP client over a real
 * Streamable HTTP connection into a real FastMCP server listening on a local port, with the
 * adapter under test in front of it. Only Auth0 and the downstream API are intercepted (MSW);
 * requests to the loopback address pass through.
 */
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { decodeJwt } from "jose";
import { z } from "zod";
import { FastMCP, UserError, requireScopes } from "fastmcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpClient, getCallerMcpClient, getCallerPrincipal, requireScopes as requireAuth0Scopes } from "@auth0/ai-mcp";
import type { McpClient, McpClientOptions } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import type { Auth0Session, FastMcpAuth, FastMcpAuthBaseOptions } from "../../src/index.js";
import {
  createAuth0Handlers,
  createDownstreamOracle,
  createTestKey,
  exportJwks,
  mintAccessToken,
} from "../support/index.js";
import type { Auth0Handlers, DownstreamOracle, MintAccessTokenOptions, TestKey } from "../support/index.js";

/**
 * The platform `fetch`, captured before MSW patches the global one. The client talks to the local
 * server through it. Auth0 and downstream calls made by the server still go through the patched
 * global `fetch` and are intercepted.
 */
export const socketFetch: typeof fetch = globalThis.fetch;

export const DOMAIN = "tenant.example.com";
export const DOWNSTREAM = "https://api.example.com";
export const DOWNSTREAM_URL = `${DOWNSTREAM}/data`;

export interface Tenant {
  key: TestKey;
  auth0: Auth0Handlers;
  oracle: DownstreamOracle;
}

export interface Rig {
  tenant: Tenant;
  /** URLs of the requests the server made to Auth0 and the downstream API during the test. */
  readonly requests: string[];
  /** Adds handlers for the current test. They are dropped again after the test. */
  use(...handlers: Parameters<ReturnType<typeof setupServer>["use"]>): void;
  /** Mints an access token for the audience of `server`. */
  token(server: { audience: string }, options?: MintAccessTokenOptions): Promise<string>;
  reset(): void;
}

export interface Hooks {
  beforeAll: (fn: () => Promise<void> | void) => void;
  afterEach: (fn: () => Promise<void> | void) => void;
  afterAll: (fn: () => Promise<void> | void) => void;
}

/** Creates the tenant and the MSW server. Call at module scope of a spec file. */
export function createRig(hooks: Hooks): () => Rig {
  const msw = setupServer();
  let rig: Rig | undefined;
  let baseHandlers: Parameters<typeof msw.use> = [];

  hooks.beforeAll(async () => {
    const key = await createTestKey();
    const auth0 = createAuth0Handlers({ key, domain: DOMAIN });
    const oracle = createDownstreamOracle({
      jwks: exportJwks(key),
      issuer: auth0.issuer,
      audience: DOWNSTREAM,
      requiredScope: "api:read",
    });
    const tenant: Tenant = { key, auth0, oracle };
    const handlers = [...auth0.handlers, oracle.handler(DOWNSTREAM_URL)];
    msw.listen({
      onUnhandledRequest(request, print) {
        const host = new URL(request.url).hostname;
        if (host === "127.0.0.1" || host === "localhost") return;
        print.error();
      },
    });
    msw.use(...handlers);
    baseHandlers = handlers;
    const requests: string[] = [];
    msw.events.on("request:start", ({ request }) => {
      requests.push(request.url);
    });
    rig = {
      tenant,
      requests,
      use: (...extra) => msw.use(...extra),
      async token(server, options = {}) {
        return mintAccessToken(key, {
          iss: auth0.issuer,
          aud: server.audience,
          sub: "user|1",
          scope: "read:orders",
          claims: { azp: "client-a" },
          ...options,
        });
      },
      reset() {
        auth0.state.reset();
        oracle.reset();
        requests.length = 0;
      },
    };
  });
  hooks.afterEach(() => {
    msw.resetHandlers(...baseHandlers);
    rig?.reset();
  });
  hooks.afterAll(() => msw.close());

  return () => {
    if (rig === undefined) throw new Error("The rig is not installed yet.");
    return rig;
  };
}

/** A port nobody listens on right now. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Runs `fn` with environment variables set, then restores them. */
function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const silentLogger = { debug() {}, error() {}, info() {}, log() {}, warn() {} };

/** What the standard tools call while they run, so a test can make calls overlap. */
export interface ToolHooks {
  /** Awaited at the start of `whoami` and `whoami_raw`. */
  barrier?: () => Promise<void>;
  /** Raw errors the wrapper reported. */
  errors: unknown[];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Registers the tools the suites call. */
export function registerStandardTools(server: FastMCP<Auth0Session>, tool: ToolHooks): void {
  const onError = (error: unknown) => {
    tool.errors.push(error);
  };
  const parameters = z.object({ delay: z.number().optional() });

  server.addTool({
    name: "whoami",
    description: "Reports the caller as the session and the accessors see it.",
    parameters,
    execute: withAuth0Execute(async (args, ctx) => {
      await tool.barrier?.();
      if (args.delay) await sleep(args.delay);
      await sleep(1);
      return json({
        sessionSub: ctx.session?.principal.sub ?? null,
        accessorSub: getCallerPrincipal()?.sub ?? null,
        clientSub: getCallerMcpClient()?.getPrincipal().sub ?? null,
        scopes: ctx.session?.scopes ?? null,
      });
    }),
  });

  server.addTool({
    name: "whoami_raw",
    description: "The same report without the wrapper.",
    parameters,
    execute: async (args, ctx) => {
      await tool.barrier?.();
      if (args.delay) await sleep(args.delay);
      await sleep(1);
      return json({
        sessionSub: ctx.session?.principal.sub ?? null,
        accessorSub: getCallerPrincipal()?.sub ?? null,
        clientBound: getCallerMcpClient() !== undefined,
      });
    },
  });

  server.addTool({
    name: "delegate",
    description: "Exchanges the caller's token and calls the downstream API with it.",
    parameters: z.object({ scope: z.string().optional() }),
    execute: withAuth0Execute(async (args, ctx) => {
      const exchanged = await ctx.session!.mcpClient.getTokenOnBehalfOf({
        audience: DOWNSTREAM,
        scope: args.scope ?? "api:read",
      });
      const claims = decodeJwt(exchanged.accessToken);
      const response = await fetch(DOWNSTREAM_URL, {
        headers: { authorization: `Bearer ${exchanged.accessToken}` },
      });
      return json({ status: response.status, sub: claims.sub, aud: claims.aud, scope: claims["scope"] });
    }, { onError }),
  });

  server.addTool({
    name: "admin",
    description: "Needs the admin scope.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => "admin ok", { requiredScopes: "admin:all", onError }),
  });

  server.addTool({
    name: "inner_scope",
    description: "Checks the scope inside the body with the ai-mcp helper.",
    parameters: z.object({}),
    execute: withAuth0Execute(async (_args, ctx) => {
      requireAuth0Scopes(["write:orders"], ctx.session!.principal);
      return "write ok";
    }, { onError }),
  });

  server.addTool({
    name: "hidden",
    description: "Hidden from callers without the admin scope.",
    parameters: z.object({}),
    canAccess: requireScopes("admin:all"),
    execute: withAuth0Execute(async () => "hidden ok", { onError }),
  });

  server.addTool({
    name: "throws",
    description: "Throws an error with a secret in its message.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => {
      throw new Error("db password is hunter2");
    }, { onError }),
  });

  server.addTool({
    name: "throws_raw",
    description: "Throws without the wrapper.",
    parameters: z.object({}),
    execute: async () => {
      throw new Error("db password is hunter2");
    },
  });

  server.addTool({
    name: "user_error",
    description: "Throws a FastMCP UserError.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => {
      throw new UserError("the order does not exist");
    }, { onError }),
  });
}

export interface StartOptions {
  stateless?: boolean;
  endpoint?: `/${string}`;
  /** Options for the adapter, other than the client. */
  auth?: Omit<FastMcpAuthBaseOptions, "endpoint">;
  /** Overrides for the client created for the server. */
  clientOptions?: Partial<McpClientOptions>;
  /** How the adapter is configured. Defaults to `client`. */
  configuration?: "client" | "inline" | "env";
  /** Publishes the origin alone as the resource and audience, while FastMCP serves `endpoint`. */
  resourceAtRoot?: boolean;
  /** Registers tools instead of the standard set. */
  tools?: (server: FastMCP<Auth0Session>, hooks: ToolHooks) => void;
  barrier?: () => Promise<void>;
}

export interface TestServer {
  /** The URL the client connects to. */
  url: URL;
  origin: string;
  endpoint: string;
  port: number;
  /** The audience of the server and the resource it publishes. */
  audience: string;
  fastmcp: FastMCP<Auth0Session>;
  auth: FastMcpAuth;
  /** The client the adapter was given. Only set when the configuration is `client`. */
  client: McpClient | undefined;
  errors: unknown[];
  stop(): Promise<void>;
}

/** Starts a FastMCP server with the adapter on a local port. */
export async function startServer(options: StartOptions = {}): Promise<TestServer> {
  const port = await freePort();
  const endpoint = options.endpoint ?? "/mcp";
  const origin = `http://127.0.0.1:${port}`;
  const audience = options.resourceAtRoot ? origin : `${origin}${endpoint}`;
  const clientOptions: McpClientOptions = {
    domain: DOMAIN,
    audience,
    clientId: "mcp-client",
    clientSecret: "secret",
    ...options.clientOptions,
  };
  let client: McpClient | undefined;
  let auth: FastMcpAuth;
  const configuration = options.configuration ?? "client";
  if (configuration === "inline") {
    auth = createFastMcpAuth({ ...clientOptions, endpoint, ...options.auth });
  } else if (configuration === "env") {
    auth = withEnv(
      {
        AUTH0_DOMAIN: clientOptions.domain,
        AUTH0_AUDIENCE: clientOptions.audience,
        AUTH0_CLIENT_ID: clientOptions.clientId,
        AUTH0_CLIENT_SECRET: clientOptions.clientSecret,
      },
      () => createFastMcpAuth({ endpoint, ...options.auth }),
    );
  } else {
    client = createMcpClient(clientOptions);
    auth = createFastMcpAuth({ client, endpoint, ...options.auth });
  }
  const fastmcp = new FastMCP<Auth0Session>({
    name: "integration",
    version: "1.0.0",
    logger: silentLogger,
    ...auth,
  });
  const errors: unknown[] = [];
  const hooks: ToolHooks = { errors, ...(options.barrier !== undefined && { barrier: options.barrier }) };
  (options.tools ?? registerStandardTools)(fastmcp, hooks);
  await fastmcp.start({
    transportType: "httpStream",
    httpStream: { port, host: "127.0.0.1", stateless: options.stateless ?? true, endpoint },
  });
  return {
    url: new URL(`${origin}${endpoint}`),
    origin,
    endpoint,
    port,
    audience,
    fastmcp,
    auth,
    client,
    errors,
    stop: () => fastmcp.stop(),
  };
}

/** A response as the client transport saw it. */
export interface Seen {
  method: string;
  status: number;
  wwwAuthenticate: string | null;
}

export interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
  seen: Seen[];
  close(): Promise<void>;
}

/**
 * Connects a real MCP client. `bearer` is sent as the `Authorization` header on every request.
 * Rejects with the client's own error when the server refuses the connection; `seen` still holds
 * every response the transport received.
 */
export async function connect(
  server: { url: URL },
  bearer?: string | { authorization: string },
  extraHeaders: Record<string, string> = {},
): Promise<Session> {
  const seen: Seen[] = [];
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await socketFetch(input, init);
    seen.push({
      method: (input instanceof Request ? input.method : (init?.method ?? "GET")).toUpperCase(),
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate"),
    });
    return response;
  }) as typeof fetch;
  const authorization =
    bearer === undefined ? undefined : typeof bearer === "string" ? `Bearer ${bearer}` : bearer.authorization;
  const transport = new StreamableHTTPClientTransport(server.url, {
    fetch: recording,
    requestInit: { headers: { ...(authorization !== undefined && { authorization }), ...extraHeaders } },
  });
  const client = new Client({ name: "integration-client", version: "1.0.0" });
  await client.connect(transport).catch(async (error: unknown) => {
    await client.close().catch(() => undefined);
    throw Object.assign(error as Error, { seen });
  });
  return {
    client,
    transport,
    seen,
    async close() {
      await client.close();
    },
  };
}

export interface ToolOutcome<T> {
  isError: boolean;
  text: string;
  value: T;
  meta: Record<string, unknown> | undefined;
}

/** Calls a tool and parses the text as JSON when it is JSON. */
export async function callTool<T = unknown>(
  session: Session,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome<T>> {
  const result = (await session.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    _meta?: Record<string, unknown>;
  };
  const text = result.content[0]?.text ?? "";
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Error results carry plain text.
  }
  return { isError: result.isError === true, text, value: value as T, meta: result._meta };
}

/** One raw request to the server, with the platform fetch. */
export async function rawRequest(
  server: { url: URL },
  init: { method?: string; headers?: Record<string, string>; body?: unknown; path?: string } = {},
): Promise<Response> {
  const url = init.path === undefined ? server.url : new URL(init.path, server.url);
  return socketFetch(url, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...init.headers,
    },
    ...(init.body !== undefined && { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
  });
}

/**
 * The last JSON message in a response body that is either plain JSON or a server-sent event
 * stream. The stream may start with an empty priming event.
 */
export function parseMessage(body: string): unknown {
  const events = [...body.matchAll(/^data: (.*)$/gm)].map((match) => match[1]!).filter((data) => data.trim() !== "");
  return JSON.parse(events.length > 0 ? events[events.length - 1]! : body);
}

/** A parsed `WWW-Authenticate` header with a single challenge. */
export interface Challenge {
  scheme: string;
  params: Record<string, string>;
}

/** Parses one `Scheme a="b", c="d"` challenge. Fails the test when the header holds anything else. */
export function parseChallenge(header: string | null): Challenge {
  if (header === null) throw new Error("The response carried no WWW-Authenticate header.");
  const match = /^([A-Za-z]+)(?: (.*))?$/.exec(header);
  if (match === null) throw new Error(`Unparseable challenge: ${header}`);
  const params: Record<string, string> = {};
  const rest = match[2] ?? "";
  const pattern = /([a-z_]+)="([^"]*)"(?:, |$)/g;
  let consumed = 0;
  for (let found = pattern.exec(rest); found !== null; found = pattern.exec(rest)) {
    params[found[1]!] = found[2]!;
    consumed = pattern.lastIndex;
  }
  if (consumed !== rest.length) throw new Error(`Unparseable challenge parameters: ${rest}`);
  return { scheme: match[1]!, params };
}

export const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1.0.0" } },
};

/** Starts a server, runs `fn` against it and always stops it. */
export async function withServer<T>(options: StartOptions, fn: (server: TestServer) => Promise<T>): Promise<T> {
  const server = await startServer(options);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

/** Releases all waiters once `count` of them have arrived. */
export function createBarrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived++;
    if (arrived >= count) release();
    await open;
  };
}

export { http, HttpResponse };
