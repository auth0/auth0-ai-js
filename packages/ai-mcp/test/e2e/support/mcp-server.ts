/**
 * Boots the handler under test on an ephemeral localhost port: a real `http.Server` mounted with
 * `createNodeMcpHandler`, a real `createMcpClient` against the tenant, and tools that call the
 * downstream API through the request-scoped client.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { createMcpClient } from "../../../src/client.js";
import type { McpClient } from "../../../src/client.js";
import { createMcpSdkHandler, createNodeMcpHandler } from "../../../src/mcp-sdk.js";
import { getRequestContext } from "../../../src/request-context.js";
import type { McpClientOptions } from "../../../src/types.js";
import type { E2eEnv } from "./env.js";

/** One downstream service the `multi-downstream` tool can call. */
export interface DownstreamTarget {
  /** Audience the token is exchanged for. */
  audience: string;
  /** URL the exchanged token is sent to as a bearer. */
  url: string;
  /** Scope requested for this audience. Defaults to the contract's downstream scope. */
  scope?: string;
}

/**
 * How the handler under test gets its client. `client` builds one with `createMcpClient` and
 * passes it (the default). `inline` passes the connection settings as handler options. `env`
 * passes none of them: the handler reads `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID`
 * and `AUTH0_CLIENT_SECRET`, which the support code sets while the handler is constructed and
 * restores right after.
 */
export type E2eConfigurationTier = "client" | "inline" | "env";

export interface E2eMcpServerOptions {
  env: E2eEnv;
  /** Configuration tier of the handler. Defaults to `client`. */
  configuration?: E2eConfigurationTier;
  /** Downstream API URL the `delegate` tool calls (see `startDownstreamApi`). */
  downstreamUrl: string;
  /** Audience the server accepts. Defaults to the MCP API of the contract. */
  audience?: string;
  scopeMatching?: McpClientOptions["scopeMatching"];
  /** Token store. Omitted or `null` means no store at all: no caching, single-flight only. */
  tokenStore?: McpClientOptions["tokenStore"] | null;
  /** Overrides the OBO client secret (for example to provoke `invalid_client`). */
  clientSecret?: string;
  /** DPoP settings of the ingress client: `{ mode: "allowed" | "required" | "disabled", ... }`. */
  dpop?: McpClientOptions["dpop"];
  organizationPolicy?: McpClientOptions["organizationPolicy"];
  organizationId?: McpClientOptions["organizationId"];
  /** Scopes every request must carry (handler level, answered with 403). */
  requiredScopes?: readonly string[];
  /** Request timeout of the wrapper client, for every call it makes to the tenant. Library default when omitted. */
  requestTimeoutMs?: number;
  /** Fixed local port to listen on. Defaults to an ephemeral port (0). */
  port?: number;
  /**
   * Downstream services the `multi-downstream` tool can exchange for. Each entry pairs an audience
   * with the URL that audience's service listens on. The tool is registered only when this list is
   * non-empty.
   */
  downstreams?: readonly DownstreamTarget[];
  /**
   * Passes `resource` and `authorizationServers` to the handler instead of letting it default
   * them from the client. Off by default, so the suites run on the defaults users get.
   */
  explicitEndpoints?: boolean;
  /** Registers more tools. Each tool must read the caller from `getRequestContext()`. */
  registerTools?: (mcp: McpServer, deps: { downstreamUrl: string; env: E2eEnv }) => void;
}

export interface E2eMcpServer {
  /** MCP endpoint, `http://127.0.0.1:<port>/mcp`. */
  url: URL;
  /**
   * The URL the handler sees for the MCP endpoint (`<resource origin>/mcp`). The Node adapter
   * rebuilds requests on the resource origin, so this is the `htu` a DPoP proof must carry.
   */
  htu: string;
  /** The wrapper client the handler uses. `undefined` unless the configuration tier is `client`. */
  client: McpClient | undefined;
  close(): Promise<void>;
}

export interface E2eWebMcpServer extends E2eMcpServer {
  /** The web-standard handler itself, for calling with a hand-built `Request`. */
  handle(request: Request): Promise<Response>;
  /** Local URL of the protected resource metadata route (served by the bridge). */
  metadataUrl: URL;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Outcome the `delegate` tool reports: what the downstream API answered, never a token. */
export interface DelegateResult {
  status: number;
  body: Record<string, unknown>;
  /** Scopes the wrapper reports as granted for the exchanged token. */
  grantedScopes: string[];
}

/** One audience's outcome in the `multi-downstream` tool result. Never contains a token. */
export interface MultiDownstreamEntry {
  audience: string;
  status: number;
  body: Record<string, unknown>;
  grantedScopes: string[];
}

/** Outcome the `multi-downstream` tool reports, in the order the audiences were requested. */
export interface MultiDownstreamResult {
  results: MultiDownstreamEntry[];
}

/** Outcome the `service` tool reports: never the token itself. */
export interface ServiceResult {
  ok: true;
  hasToken: boolean;
  scopeGranted: string | null;
}

export interface ToolDeps {
  downstreamUrl: string;
  env: E2eEnv;
  downstreams: readonly DownstreamTarget[];
}

export function buildTools(deps: ToolDeps): McpServer {
  const mcp = new McpServer({ name: "e2e", version: "1.0.0" });

  mcp.registerTool("whoami", { description: "Reports the caller seen inside the tool." }, async () => {
    const context = getRequestContext();
    return json({
      sub: context?.principal.sub ?? null,
      clientId: context?.principal.clientId ?? null,
      orgId: context?.principal.orgId ?? null,
      scopes: context ? [...context.principal.scopes] : [],
    });
  });

  mcp.registerTool(
    "delegate",
    {
      description: "Exchanges the caller's token for the downstream API and calls it.",
      inputSchema: z.object({ scope: z.string().optional(), audience: z.string().optional() }),
    },
    async ({ scope, audience }) => {
      const context = getRequestContext();
      if (context === undefined) throw new Error("No request context.");
      const exchanged = await context.mcpClient.getTokenOnBehalfOf({
        audience: audience ?? deps.env.downstreamAudience,
        scope: scope ?? deps.env.downstreamScope,
      });
      const response = await fetch(deps.downstreamUrl, {
        headers: { authorization: `Bearer ${exchanged.accessToken}` },
      });
      const result: DelegateResult = {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
        grantedScopes: [...(exchanged.grantedScopes ?? [])],
      };
      return json(result);
    },
  );

  if (deps.downstreams.length > 0) {
    mcp.registerTool(
      "multi-downstream",
      {
        description: "Exchanges the caller's token for several downstream audiences and calls each service.",
        inputSchema: z.object({
          audiences: z.array(z.string()).optional(),
          parallel: z.boolean().optional(),
        }),
      },
      async ({ audiences, parallel }) => {
        const context = getRequestContext();
        if (context === undefined) throw new Error("No request context.");
        const targets = audiences === undefined
          ? deps.downstreams
          : audiences.map((audience) => {
              const target = deps.downstreams.find((t) => t.audience === audience);
              if (target === undefined) throw new Error("Unknown downstream audience.");
              return target;
            });
        const call = async (target: DownstreamTarget): Promise<MultiDownstreamEntry> => {
          const exchanged = await context.mcpClient.getTokenOnBehalfOf({
            audience: target.audience,
            scope: target.scope ?? deps.env.downstreamScope,
          });
          const response = await fetch(target.url, {
            headers: { authorization: `Bearer ${exchanged.accessToken}` },
          });
          return {
            audience: target.audience,
            status: response.status,
            body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
            grantedScopes: [...(exchanged.grantedScopes ?? [])],
          };
        };
        let results: MultiDownstreamEntry[];
        if (parallel === true) {
          results = await Promise.all(targets.map(call));
        } else {
          results = [];
          for (const target of targets) results.push(await call(target));
        }
        const result: MultiDownstreamResult = { results };
        return json(result);
      },
    );
  }

  mcp.registerTool(
    "service",
    {
      description: "Requests a third-party token through a Token Vault connection.",
      inputSchema: z.object({ connection: z.string(), loginHint: z.string().optional() }),
    },
    async ({ connection, loginHint }) => {
      const context = getRequestContext();
      if (context === undefined) throw new Error("No request context.");
      const result = await context.mcpClient.getTokenForConnection({
        connection,
        ...(loginHint !== undefined && { loginHint }),
      });
      const sanitized: ServiceResult = {
        ok: true,
        hasToken: result.accessToken.length > 0,
        scopeGranted: result.scope ?? null,
      };
      return json(sanitized);
    },
  );

  return mcp;
}

interface Built {
  client: McpClient | undefined;
  handlerOptions: Parameters<typeof createMcpSdkHandler>[0];
  audience: string;
  /** Environment values the handler reads while it is constructed (tier `env` only). */
  handlerEnv: Record<string, string>;
}

/** Runs `construct` with the given variables set, then restores the previous values. */
function withEnvironment<T>(values: Record<string, string>, construct: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return construct();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function build(options: E2eMcpServerOptions): Built {
  const { env } = options;
  const audience = options.audience ?? env.mcpAudience;
  const tier = options.configuration ?? "client";
  const clientSecret = options.clientSecret ?? env.oboClientSecret;
  const tuning = {
    ...(options.scopeMatching !== undefined && { scopeMatching: options.scopeMatching }),
    ...(options.tokenStore !== undefined && options.tokenStore !== null && { tokenStore: options.tokenStore }),
    ...(options.organizationPolicy !== undefined && { organizationPolicy: options.organizationPolicy }),
    ...(options.organizationId !== undefined && { organizationId: options.organizationId }),
    ...(options.dpop !== undefined && { dpop: options.dpop }),
    ...(options.requestTimeoutMs !== undefined && { requestTimeoutMs: options.requestTimeoutMs }),
  };
  const connection = {
    domain: env.domain,
    audience,
    clientId: env.oboClientId,
    clientSecret,
  };
  const deps: ToolDeps = {
    downstreamUrl: options.downstreamUrl,
    env,
    downstreams: options.downstreams ?? [],
  };

  let client: McpClient | undefined;
  let clientPart: Record<string, unknown>;
  let handlerEnv: Record<string, string> = {};
  if (tier === "client") {
    client = createMcpClient({ ...connection, ...tuning });
    clientPart = { client };
  } else if (tier === "inline") {
    clientPart = { ...connection, ...tuning };
  } else {
    clientPart = { ...tuning };
    handlerEnv = {
      AUTH0_DOMAIN: connection.domain,
      AUTH0_AUDIENCE: connection.audience,
      AUTH0_CLIENT_ID: connection.clientId,
      AUTH0_CLIENT_SECRET: connection.clientSecret,
    };
  }
  return {
    client,
    audience,
    handlerEnv,
    handlerOptions: {
      ...clientPart,
      ...(options.explicitEndpoints === true && {
        resource: audience,
        authorizationServers: [env.issuer],
      }),
      ...(options.requiredScopes !== undefined && { requiredScopes: options.requiredScopes }),
      createServer: () => {
        const mcp = buildTools(deps);
        options.registerTools?.(mcp, deps);
        return mcp;
      },
    } as Parameters<typeof createMcpSdkHandler>[0],
  };
}

async function listen(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  port = 0,
): Promise<{ httpServer: HttpServer; port: number; close(): Promise<void> }> {
  const httpServer: HttpServer = createServer(listener);
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  return {
    httpServer,
    port: (httpServer.address() as AddressInfo).port,
    async close() {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Thin Node-to-web bridge for the web-standard handler. It only converts the message shapes
 * (IncomingMessage to a WHATWG `Request` on the resource origin, `Response` back to the socket)
 * and holds no authentication logic, so it exercises `createMcpSdkHandler` rather than the
 * wrapper's own Node adapter.
 */
function bridge(
  handle: (request: Request) => Promise<Response>,
  origin: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      const method = req.method ?? "GET";
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
      const response = await handle(new Request(origin + (req.url ?? "/"), { method, headers, body }));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.appendHeader(name, value));
      if (response.body === null) {
        res.end();
        return;
      }
      // Stream the body so server-sent events reach the client as they are written.
      const reader = response.body.getReader();
      let closed = false;
      res.once("close", () => {
        closed = true;
        void reader.cancel().catch(() => undefined);
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        if (!res.write(value) && !closed) {
          await new Promise<void>((resolve) => {
            const settle = () => {
              res.off("drain", settle);
              res.off("close", settle);
              resolve();
            };
            res.once("drain", settle);
            res.once("close", settle);
          });
        }
      }
      if (!closed) res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("x-e2e-bridge-error", err instanceof Error ? err.name : "unknown");
        res.end();
        return;
      }
      res.destroy(err instanceof Error ? err : new Error("bridge failure"));
    });
  };
}

/**
 * Starts the server on the wrapper's Node adapter (`createNodeMcpHandler`). Always `close()` it in
 * `afterEach` or `afterAll`. Tools: `whoami`, `delegate`, `service`, and `multi-downstream` when `downstreams` is given.
 */
export async function startMcpServer(options: E2eMcpServerOptions): Promise<E2eMcpServer> {
  const { client, handlerOptions, audience, handlerEnv } = build(options);
  // Built once, like a real server: an environment-configured handler reads the variables here.
  const listener = withEnvironment(handlerEnv, () => createNodeMcpHandler(handlerOptions));
  const server = await listen((req, res) => void listener(req, res), options.port);
  return {
    url: new URL(`http://127.0.0.1:${server.port}/mcp`),
    htu: `${new URL(audience).origin}/mcp`,
    client,
    close: server.close,
  };
}

/**
 * Starts the server on the web-standard handler (`createMcpSdkHandler`, `Request` to `Response`),
 * bridged to a local port by a thin adapter, and also returns the handler for direct calls.
 * The bridge builds requests on the resource origin like the Node adapter, so `htu` matches.
 */
export async function startWebMcpServer(options: E2eMcpServerOptions): Promise<E2eWebMcpServer> {
  const { client, handlerOptions, audience, handlerEnv } = build(options);
  const handle = withEnvironment(handlerEnv, () => createMcpSdkHandler(handlerOptions));
  const origin = new URL(audience).origin;
  const server = await listen(bridge(handle, origin), options.port);
  const resourcePath = new URL(audience).pathname.replace(/\/$/, "");
  return {
    url: new URL(`http://127.0.0.1:${server.port}/mcp`),
    htu: `${origin}/mcp`,
    metadataUrl: new URL(`http://127.0.0.1:${server.port}/.well-known/oauth-protected-resource${resourcePath}`),
    client,
    handle,
    close: server.close,
  };
}
