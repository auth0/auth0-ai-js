/**
 * Boots the server under test: a real FastMCP server on a local port with `createFastMcpAuth`
 * in front of it, a real `@auth0/ai-mcp` client against the tenant, and tools that call the
 * downstream API through the session. Nothing here is mocked.
 */
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { FastMCP, UserError, requireScopes } from "fastmcp";
import { createMcpClient, getCallerMcpClient, getCallerPrincipal } from "@auth0/ai-mcp";
import type { McpClient, McpClientOptions } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "../../../src/index.js";
import type { Auth0Session, FastMcpAuth, FastMcpAuthBaseOptions } from "../../../src/index.js";
import type { E2eEnv } from "./env.js";

/** The canary the `throws_canary` tool puts into its error message. No response may carry it. */
export const ERROR_CANARY = "e2e-canary-secret-9f3a";

/**
 * How the adapter gets its client: a client built and passed in, every connection setting passed
 * inline, none passed (read from the four `AUTH0_` variables), or the client id and secret passed
 * with the domain and audience read from the environment.
 */
export type E2eConfigurationTier = "client" | "inline" | "env" | "partial";

export interface FastMcpServerOptions {
  env: E2eEnv;
  /** Downstream API URL the `delegate` tool calls (see `startDownstreamApi`). */
  downstreamUrl: string;
  /** Run FastMCP statelessly (one request, one transport) or with sessions. Defaults to stateless. */
  stateless?: boolean;
  /** How the adapter gets its client. Defaults to `client`. */
  configuration?: E2eConfigurationTier;
  /** Audience of the server and the resource it publishes. Defaults to the MCP API of the contract. */
  audience?: string;
  /** Route FastMCP serves the MCP endpoint on. Defaults to `/mcp`. */
  endpoint?: `/${string}`;
  /** Client used for the exchange. Defaults to the exchange client of the contract. */
  clientId?: string;
  clientSecret?: string;
  /** Tuning options of the client: store, scope matching, DPoP mode, timeout. */
  clientOptions?: Pick<McpClientOptions, "tokenStore" | "scopeMatching" | "dpop" | "requestTimeoutMs">;
  /** Options of the adapter other than the client and the endpoint. */
  auth?: Omit<FastMcpAuthBaseOptions, "endpoint">;
  /** Local port. Defaults to the port of a loopback audience, else a free port. */
  port?: number;
}

export interface FastMcpServer {
  /** The MCP endpoint on the local port, `http://127.0.0.1:<port><endpoint>`. */
  url: URL;
  /** Origin of {@link FastMcpServer.url}. */
  origin: string;
  endpoint: string;
  port: number;
  stateless: boolean;
  audience: string;
  /** The client the adapter was given. Only set when the configuration is `client`. */
  client: McpClient | undefined;
  auth: FastMcpAuth;
  /** Raw errors the adapter and the tools reported through `onError`. */
  errors: unknown[];
  /** Everything FastMCP logged, as text. A response must never contain a token that appears here. */
  logs: string[];
  stop(): Promise<void>;
}

/** The port a loopback audience names, so the issued tokens' audience is the server's real address. */
export function loopbackPort(audience: string): number | undefined {
  try {
    const url = new URL(audience);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return loopback && url.port !== "" ? Number(url.port) : undefined;
  } catch {
    return undefined;
  }
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
function withEnv<T>(values: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** What the `whoami` tool reports. */
export interface WhoamiResult {
  sessionSub: string | null;
  accessorSub: string | null;
  clientSub: string | null;
  clientId: string | null;
  orgId: string | null;
  scopes: string[];
}

/** What the `delegate` tool reports: the downstream answer and the scopes the exchange granted. Never a token. */
export interface DelegateResult {
  status: number;
  body: Record<string, unknown>;
  grantedScopes: string[];
}

interface ToolDeps {
  downstreamUrl: string;
  env: E2eEnv;
  errors: unknown[];
}

function registerTools(server: FastMCP<Auth0Session>, deps: ToolDeps): void {
  const onError = (error: unknown) => {
    deps.errors.push(error);
  };

  server.addTool({
    name: "whoami",
    description: "Reports the caller as the session and the accessors see it.",
    parameters: z.object({ delayMs: z.number().optional() }),
    execute: withAuth0Execute(async (args, ctx) => {
      if (args.delayMs !== undefined) await sleep(args.delayMs);
      const result: WhoamiResult = {
        sessionSub: ctx.session?.principal.sub ?? null,
        accessorSub: getCallerPrincipal()?.sub ?? null,
        clientSub: getCallerMcpClient()?.getPrincipal().sub ?? null,
        clientId: ctx.session?.principal.clientId ?? null,
        orgId: ctx.session?.principal.orgId ?? null,
        scopes: [...(ctx.session?.scopes ?? [])],
      };
      return json(result);
    }, { onError }),
  });

  server.addTool({
    name: "whoami_raw",
    description: "The session without the wrapper: the accessors are not bound here.",
    parameters: z.object({}),
    execute: async (_args, ctx) =>
      json({ sessionSub: ctx.session?.principal.sub ?? null, accessorBound: getCallerPrincipal() !== undefined }),
  });

  server.addTool({
    name: "delegate",
    description: "Exchanges the caller's token for the downstream API and calls it.",
    parameters: z.object({ scope: z.string().optional(), audience: z.string().optional() }),
    execute: withAuth0Execute(async (args, ctx) => {
      const exchanged = await ctx.session!.mcpClient.getTokenOnBehalfOf({
        audience: args.audience ?? deps.env.downstreamAudience,
        scope: args.scope ?? deps.env.downstreamScope,
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
    }, { onError }),
  });

  server.addTool({
    name: "delegate_via_accessor",
    description: "The same exchange, reaching the client through the accessor instead of the session.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => {
      const client = getCallerMcpClient();
      if (client === undefined) return json({ bound: false });
      const exchanged = await client.getTokenOnBehalfOf({
        audience: deps.env.downstreamAudience,
        scope: deps.env.downstreamScope,
      });
      return json({ bound: true, hasToken: exchanged.accessToken.length > 0 });
    }, { onError }),
  });

  server.addTool({
    name: "needs_delegate",
    description: "Needs the delegate scope. The tool stays listed for callers without it.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => "delegate allowed", { requiredScopes: "tool:delegate", onError }),
  });

  server.addTool({
    name: "needs_never",
    description: "Needs a scope no client holds.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => "never reached", { requiredScopes: "e2e:never-granted", onError }),
  });

  server.addTool({
    name: "hidden_without_delegate",
    description: "Hidden from callers without the delegate scope.",
    parameters: z.object({}),
    canAccess: requireScopes("tool:delegate"),
    execute: withAuth0Execute(async () => "hidden allowed", { onError }),
  });

  server.addTool({
    name: "throws_canary",
    description: "Throws an error whose message carries a canary.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => {
      throw new Error(`database password is ${ERROR_CANARY}`);
    }, { onError }),
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

/**
 * Starts the FastMCP server on a local port. Always `stop()` it in `afterEach` or `afterAll`: the
 * MCP audience of the contract is a fixed loopback address, so only one server can run at a time.
 */
export async function startFastMcpServer(options: FastMcpServerOptions): Promise<FastMcpServer> {
  const { env } = options;
  const audience = options.audience ?? env.mcpAudience;
  const endpoint = options.endpoint ?? "/mcp";
  const stateless = options.stateless ?? true;
  const port = options.port ?? loopbackPort(audience) ?? (await freePort());
  const configuration = options.configuration ?? "client";
  const connection = {
    domain: env.domain,
    audience,
    clientId: options.clientId ?? env.oboClientId,
    clientSecret: options.clientSecret ?? env.oboClientSecret,
  };
  const tuning = options.clientOptions ?? {};

  let client: McpClient | undefined;
  let auth: FastMcpAuth;
  if (configuration === "client") {
    client = createMcpClient({ ...connection, ...tuning });
    auth = createFastMcpAuth({ client, endpoint, ...options.auth });
  } else if (configuration === "inline") {
    auth = createFastMcpAuth({ ...connection, ...tuning, endpoint, ...options.auth });
  } else if (configuration === "partial") {
    auth = withEnv(
      { AUTH0_DOMAIN: connection.domain, AUTH0_AUDIENCE: connection.audience },
      () =>
        createFastMcpAuth({
          clientId: connection.clientId,
          clientSecret: connection.clientSecret,
          ...tuning,
          endpoint,
          ...options.auth,
        }),
    );
  } else {
    // No connection settings are passed: the four AUTH0_ variables exist only while the adapter is built.
    auth = withEnv(
      {
        AUTH0_DOMAIN: connection.domain,
        AUTH0_AUDIENCE: connection.audience,
        AUTH0_CLIENT_ID: connection.clientId,
        AUTH0_CLIENT_SECRET: connection.clientSecret,
      },
      () => createFastMcpAuth({ ...tuning, endpoint, ...options.auth }),
    );
  }

  const logs: string[] = [];
  const record = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 4 }))).join(" "));
  };
  const logger = { debug: record, error: record, info: record, log: record, warn: record };

  const errors: unknown[] = [];
  const fastmcp = new FastMCP<Auth0Session>({ name: "e2e", version: "1.0.0", logger, ...auth });
  registerTools(fastmcp, { downstreamUrl: options.downstreamUrl, env, errors });
  try {
    await fastmcp.start({
      transportType: "httpStream",
      httpStream: { port, host: "127.0.0.1", stateless, endpoint },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`The test server could not listen on 127.0.0.1:${port}${code !== undefined ? ` (${code})` : ""}.`, {
      cause: error,
    });
  }

  const origin = `http://127.0.0.1:${port}`;
  return {
    url: new URL(`${origin}${endpoint}`),
    origin,
    endpoint,
    port,
    stateless,
    audience,
    client,
    auth,
    errors,
    logs,
    stop: () => fastmcp.stop(),
  };
}
