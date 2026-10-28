/**
 * Shared rig for the integration suites. Every test drives a real MCP SDK `Client` over a real
 * `StreamableHTTPClientTransport` into a server built from this package. Only Auth0 and the
 * downstream API are intercepted (MSW); requests to localhost pass through.
 *
 * Two wirings are supported. The node wiring is the real-socket path: the SDK client reaches an
 * `http.Server` over TCP. The web wiring is exercised in-process through the Fetch API: the
 * transport's `fetch` calls the web handler with a real `Request` and receives a real `Response`,
 * with no socket in between.
 * - `node`: `http.createServer` on an ephemeral port, mounted with `createNodeMcpHandler`.
 * - `web`: `createMcpSdkHandler` called with the standard `Request` the transport builds, through
 *   the transport's `fetch` option. Headers and bodies are the transport's own.
 */
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpClient } from "../../src/client.js";
import type { McpClient } from "../../src/client.js";
import { createMcpSdkHandler, createNodeMcpHandler } from "../../src/mcp-sdk.js";
import type { McpSdkHandlerOptions } from "../../src/mcp-sdk.js";
import { getRequestContext } from "../../src/request-context.js";
import { withRequiredScopes } from "../../src/scopes.js";
import {
  createAuth0Handlers,
  createDownstreamOracle,
  createTestKey,
  exportJwks,
  mintAccessToken,
  scopeMode,
} from "../support/index.js";
import type { Auth0Handlers, DownstreamOracle, MintAccessTokenOptions, TestKey } from "../support/index.js";

/**
 * The platform `fetch`, captured before MSW patches the global one. The SDK client talks to the
 * local server through it: MSW's patched `fetch` never finishes cancelling a response body that
 * came over a real socket, which the SDK does after every 202 reply. Auth0 and downstream calls
 * made by the server still go through the patched global `fetch` and are intercepted.
 */
const socketFetch: typeof fetch = globalThis.fetch;

export const ORIGIN = "https://mcp.example.com";
export const AUDIENCE = ORIGIN;
export const ENDPOINT = `${ORIGIN}/mcp`;
export const DOWNSTREAM = "https://api.example.com";

export type Wiring = "node" | "web";
export const WIRINGS: Wiring[] = ["node", "web"];

/** A tenant plus a downstream API that only accepts tokens that tenant issued for it. */
export interface Tenant {
  key: TestKey;
  auth0: Auth0Handlers;
  oracle: DownstreamOracle;
  /** Absolute URL of this tenant's downstream endpoint. */
  downstreamUrl: string;
  domain: string;
}

export interface Rig {
  server: ReturnType<typeof setupServer>;
  tenant: Tenant;
  /** Registers another tenant (own domain, key and downstream endpoint). */
  addTenant(domain: string): Promise<Tenant>;
  /** Registers the handlers of a tenant with MSW. Call once per test, after reset. */
  useTenant(tenant?: Tenant): void;
  /** Mints an access token for the MCP server. */
  token(options?: Omit<MintAccessTokenOptions, "iss" | "aud"> & { tenant?: Tenant }): Promise<string>;
  /** Resets counters and handlers between tests. */
  reset(): void;
  /** Every token a downstream API received was verified by its oracle. */
  assertAllForwardedTokensVerified(): void;
}

/** What the `delegate` tool reports about the downstream call. */
export interface DelegateOutcome {
  status: number;
  body: {
    ok: boolean;
    sub?: string;
    orgId?: string | null;
    scopes?: string[];
    jti?: string;
    reason?: string;
  };
}

/** Creates the tenant, MSW server and lifecycle helpers. Call at module scope of a spec file. */
export function createRig(): { rig: () => Rig; install: (hooks: Hooks) => void } {
  const server = setupServer();
  let current: Rig | undefined;
  let tenants: Tenant[] = [];

  async function makeTenant(domain: string, scopeKind = scopeMode.echo): Promise<Tenant> {
    const key = await createTestKey();
    const auth0 = createAuth0Handlers({ key, domain, scope: scopeKind });
    const downstreamUrl = `${DOWNSTREAM}/${domain}/data`;
    const oracle = createDownstreamOracle({
      jwks: exportJwks(key),
      issuer: auth0.issuer,
      audience: DOWNSTREAM,
      requiredScope: "api:read",
    });
    const tenant: Tenant = { key, auth0, oracle, downstreamUrl, domain };
    tenants.push(tenant);
    return tenant;
  }

  function handlersFor(tenant: Tenant) {
    return [
      ...tenant.auth0.handlers,
      http.all(tenant.downstreamUrl, async ({ request }) => {
        const verdict = await tenant.oracle.verifyAuthorization(request.headers.get("authorization"));
        if (!verdict.ok) {
          return HttpResponse.json(
            { ok: false, reason: verdict.reason },
            { status: verdict.status },
          );
        }
        const claims = verdict.claims;
        return HttpResponse.json({
          ok: true,
          sub: claims.sub,
          orgId: (claims["org_id"] as string | undefined) ?? null,
          scopes: verdict.scopes,
          jti: claims.jti,
        });
      }),
    ];
  }

  const install = (hooks: Hooks) => {
    hooks.beforeAll(async () => {
      tenants = [];
      const tenant = await makeTenant("tenant.example.com");
      current = {
        server,
        tenant,
        async addTenant(domain) {
          return makeTenant(domain);
        },
        useTenant(target = tenant) {
          server.use(...handlersFor(target));
        },
        async token(options = {}) {
          const { tenant: target = tenant, ...rest } = options;
          return mintAccessToken(target.key, {
            iss: target.auth0.issuer,
            aud: AUDIENCE,
            sub: "user|1",
            scope: "read write",
            claims: { client_id: "client-a" },
            ...rest,
          });
        },
        reset() {
          server.resetHandlers();
          for (const t of tenants) {
            t.auth0.state.reset();
            t.oracle.reset();
          }
        },
        assertAllForwardedTokensVerified() {
          for (const t of tenants) {
            for (const call of t.oracle.calls) {
              if (!call.verdict.ok) {
                throw new Error(
                  `A forwarded token was rejected by the downstream API (${call.verdict.reason}).`,
                );
              }
            }
          }
        },
      };
      server.listen({ onUnhandledRequest: "error" });
    });
    hooks.afterEach(() => {
      current!.reset();
      tenants = tenants.slice(0, 1);
    });
    hooks.afterAll(() => server.close());
  };

  return {
    rig: () => {
      if (current === undefined) throw new Error("Rig is not installed yet.");
      return current;
    },
    install,
  };
}

interface Hooks {
  beforeAll: (fn: () => Promise<void> | void) => void;
  afterEach: (fn: () => Promise<void> | void) => void;
  afterAll: (fn: () => Promise<void> | void) => void;
}

/** Releases all waiters once `count` of them have arrived. Lets a test start N operations together. */
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

export interface ToolServerOptions {
  /** Absolute URL the `delegate` tool forwards the exchanged token to. */
  downstreamUrl: string;
  /** Awaited at the start of `delegate` and `whoami`, so concurrent calls overlap. */
  barrier?: () => Promise<void>;
  /** Scope requested by `delegate`. Defaults to `api:read`. */
  delegateScope?: string;
  /** State shared across requests, used to look for context leaking from one request to another. */
  probe?: ContextProbe;
}

/** Records what tool code observes about request contexts across requests. */
export interface ContextProbe {
  /** Contexts captured by `capture`, in order. */
  captured: unknown[];
  /** Released by the test; `linger` continuations read the context after it opens. */
  latch: Promise<void>;
  /** One entry per `linger` call: the subject its continuation saw after the latch opened. */
  pending: Array<Promise<string | null>>;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** The MCP server a request is served by. Tools read only from the request context. */
export function buildToolServer(options: ToolServerOptions): McpServer {
  const mcp = new McpServer({ name: "integration", version: "1.0.0" });

  mcp.registerTool("whoami", { description: "Reports the caller seen inside the tool." }, async () => {
    await options.barrier?.();
    // Yield so interleaved requests have a chance to overwrite shared state.
    await sleep(1);
    const context = getRequestContext();
    return text({
      contextSub: context?.principal.sub ?? null,
      clientSub: context?.mcpClient.getPrincipal().sub ?? null,
      orgId: context?.principal.orgId ?? null,
    });
  });

  mcp.registerTool(
    "delegate",
    { description: "Exchanges the caller's token and calls the downstream API with it." },
    async () => {
      await options.barrier?.();
      const context = getRequestContext();
      const exchanged = await context!.mcpClient.getTokenOnBehalfOf({
        audience: DOWNSTREAM,
        scope: options.delegateScope ?? "api:read",
      });
      const response = await fetch(options.downstreamUrl, {
        headers: { authorization: `Bearer ${exchanged.accessToken}` },
      });
      const outcome: DelegateOutcome = {
        status: response.status,
        body: (await response.json()) as DelegateOutcome["body"],
      };
      return text(outcome);
    },
  );

  mcp.registerTool("capture", { description: "Remembers this request's context object." }, async () => {
    options.probe!.captured.push(getRequestContext());
    return text({ sub: getRequestContext()?.principal.sub ?? null });
  });

  mcp.registerTool("compare", { description: "Compares this request's context with captured ones." }, async () => {
    const current = getRequestContext();
    return text({
      sub: current?.principal.sub ?? null,
      sameObjectAsEarlier: options.probe!.captured.some((c) => c === current),
      earlierSubs: options.probe!.captured.map((c) => (c as typeof current)?.principal.sub ?? null),
    });
  });

  mcp.registerTool("linger", { description: "Reads the context from a continuation that outlives the call." }, async () => {
    const probe = options.probe!;
    probe.pending.push(probe.latch.then(() => getRequestContext()?.principal.sub ?? null));
    return text({ started: true });
  });

  mcp.registerTool(
    "forward_inbound",
    { description: "Sends the caller's own inbound token downstream, which a server must never do." },
    async (extra) => {
      // AuthInfo.token is withheld (always ''), so a server that forwards the inbound token has to
      // read the raw Authorization header, the one remaining channel the transport exposes.
      const headers = (extra as { requestInfo?: { headers?: Record<string, string | string[] | undefined> } })
        .requestInfo?.headers;
      const raw = headers?.authorization;
      const authorization = Array.isArray(raw) ? raw[0] : raw;
      if (authorization === undefined) {
        throw new Error("forward_inbound: the request carried no Authorization header to forward");
      }
      const response = await fetch(options.downstreamUrl, {
        headers: { authorization },
      });
      const outcome: DelegateOutcome = {
        status: response.status,
        body: (await response.json()) as DelegateOutcome["body"],
      };
      return text(outcome);
    },
  );

  mcp.registerTool(
    "admin",
    { description: "Needs the admin scope." },
    withRequiredScopes("admin", async () => text({ secret: true })),
  );

  return mcp;
}

export function makeMcpClient(
  tenant: Tenant,
  overrides: Partial<Parameters<typeof createMcpClient>[0]> = {},
): McpClient {
  return createMcpClient({
    domain: tenant.domain,
    audience: AUDIENCE,
    clientId: "mcp-client",
    clientSecret: "secret",
    ...overrides,
  });
}

export interface App {
  /** URL the transport connects to. */
  url: URL;
  /** `fetch` the SDK transport uses to reach the server. */
  fetch: typeof fetch;
  stop(): Promise<void>;
}

export type HandlerOptions = Omit<McpSdkHandlerOptions, "resource" | "authorizationServers" | "createServer"> & {
  createServer: McpSdkHandlerOptions["createServer"];
  authorizationServers?: string[];
  /** Leaves `resource` and `authorizationServers` out so the handler applies its defaults. */
  useDefaults?: boolean;
};

/** Starts the server under test with the given wiring. */
export async function startApp(wiring: Wiring, tenant: Tenant, options: HandlerOptions): Promise<App> {
  const { useDefaults, ...rest } = options;
  const full: McpSdkHandlerOptions = useDefaults
    ? rest
    : {
        resource: AUDIENCE,
        authorizationServers: [tenant.auth0.issuer],
        ...rest,
      };

  if (wiring === "web") {
    const handle = createMcpSdkHandler(full);
    return {
      url: new URL(ENDPOINT),
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        handle(new Request(input, init))) as typeof fetch,
      async stop() {},
    };
  }

  const listener = createNodeMcpHandler(full);
  const httpServer: HttpServer = createServer((req, res) => void listener(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    fetch: socketFetch,
    async stop() {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** A response as the SDK transport saw it. */
export interface Seen {
  /** Upper-case HTTP method of the request that produced this response. */
  method: string;
  status: number;
  wwwAuthenticate: string | null;
  contentType: string | null;
}

export interface Session {
  client: Client;
  seen: Seen[];
  close(): Promise<void>;
}

/**
 * Connects a real SDK client. `bearer` is sent as the `Authorization` header on every request.
 * Rejects with the SDK's own error when the server refuses the connection; `seen` still holds
 * every response the transport received, up to and including the refusal.
 */
export async function connectClient(app: App, bearer?: string | { authorization: string }): Promise<Session> {
  const seen: Seen[] = [];
  const base = app.fetch ?? socketFetch;
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await base(input, init);
    const method = (input instanceof Request ? input.method : (init?.method ?? "GET")).toUpperCase();
    seen.push({
      method,
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate"),
      contentType: response.headers.get("content-type"),
    });
    return response;
  }) as typeof fetch;

  const authorization =
    bearer === undefined ? undefined : typeof bearer === "string" ? `Bearer ${bearer}` : bearer.authorization;
  const transport = new StreamableHTTPClientTransport(app.url, {
    fetch: recording,
    ...(authorization !== undefined && { requestInit: { headers: { authorization } } }),
  });
  const client = new Client({ name: "integration-client", version: "1.0.0" });
  await client.connect(transport).catch(async (error: unknown) => {
    await client.close().catch(() => undefined);
    throw Object.assign(error as Error, { seen });
  });
  return {
    client,
    seen,
    async close() {
      await client.close();
    },
  };
}

/** Result of `callTool` with the JSON text payload parsed. */
export async function callJson<T>(session: Session, name: string): Promise<{ isError: boolean; value: T }> {
  const result = (await session.client.callTool({ name, arguments: {} })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const first = result.content[0]?.text ?? "";
  let value: unknown = first;
  try {
    value = JSON.parse(first);
  } catch {
    // Error results carry plain text.
  }
  return { isError: result.isError === true, value: value as T };
}

/** Starts a server, runs `fn` against it and always stops it. */
export async function withApp<T>(
  wiring: Wiring,
  tenant: Tenant,
  options: HandlerOptions,
  fn: (app: App) => Promise<T>,
): Promise<T> {
  const app = await startApp(wiring, tenant, options);
  try {
    return await fn(app);
  } finally {
    await app.stop();
  }
}

export { scopeMode };

/** Connects, runs `delegate` and returns what the downstream API saw. */
export async function delegateOnce(app: App, bearer: string): Promise<DelegateOutcome> {
  const session = await connectClient(app, bearer);
  try {
    const { isError, value } = await callJson<DelegateOutcome>(session, "delegate");
    if (isError) throw new Error(`delegate failed: ${JSON.stringify(value)}`);
    return value;
  } finally {
    await session.close();
  }
}
