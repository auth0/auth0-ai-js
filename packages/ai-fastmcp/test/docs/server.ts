/**
 * A server for the documentation suites whose adapter options the test writes itself, for the
 * cases the shared integration harness does not cover (a mix of inline options and environment
 * variables, a client that lacks credentials, a store, an organization policy).
 */
import { FastMCP } from "fastmcp";
import { createFastMcpAuth } from "../../src/index.js";
import type { Auth0Session, FastMcpAuth } from "../../src/index.js";
import { freePort } from "../integration/harness.js";
import { loadSnippet } from "./guides.js";

const silentLogger = { debug() {}, error() {}, info() {}, log() {}, warn() {} };

export interface DocsServer {
  url: URL;
  origin: string;
  audience: string;
  auth: FastMcpAuth;
  fastmcp: FastMCP<Auth0Session>;
  stop(): Promise<void>;
}

export interface DocsServerOptions {
  /** Builds the adapter. Receives the audience the server will have. */
  auth: (audience: string) => FastMcpAuth | Promise<FastMcpAuth>;
  tools?: (server: FastMCP<Auth0Session>) => void;
  stateless?: boolean;
  /** The path of the audience and of the adapter's `endpoint`. */
  endpoint?: `/${string}`;
  /** The path FastMCP actually serves. Defaults to `endpoint`. Set it to create a mismatch on purpose. */
  serveEndpoint?: `/${string}`;
}

export async function startDocsServer(options: DocsServerOptions): Promise<DocsServer> {
  const port = await freePort();
  const endpoint = options.endpoint ?? "/mcp";
  const serveEndpoint = options.serveEndpoint ?? endpoint;
  const origin = `http://127.0.0.1:${port}`;
  const audience = `${origin}${endpoint}`;
  const auth = await options.auth(audience);
  const fastmcp = new FastMCP<Auth0Session>({ name: "docs", version: "1.0.0", logger: silentLogger, ...auth });
  options.tools?.(fastmcp);
  await fastmcp.start({
    transportType: "httpStream",
    httpStream: { port, host: "127.0.0.1", stateless: options.stateless ?? true, endpoint: serveEndpoint },
  });
  return { url: new URL(`${origin}${serveEndpoint}`), origin, audience, auth, fastmcp, stop: () => fastmcp.stop() };
}

/** Runs `fn` with environment variables set, then restores them. */
export async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export interface GuideServer {
  fastmcp: FastMCP<Auth0Session>;
  origin: string;
  /** The MCP URL, which is also the audience the environment names. */
  audience: string;
  url: URL;
  stop(): Promise<void>;
}

/**
 * Starts the server a guide defines. The `index`th TypeScript block of `guide` must create a
 * FastMCP server called `server` and not start it. The block runs as written, with the
 * environment set for a local audience; the test starts it on a free port in stateless mode.
 */
export async function startGuideServer(
  guide: string,
  index: number,
  options: { env?: Record<string, string | undefined>; rewrites?: Array<[string, string]> } = {},
): Promise<GuideServer> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const audience = `${origin}/mcp`;
  const loaded = await withEnv(
    {
      AUTH0_DOMAIN: "tenant.example.com",
      AUTH0_AUDIENCE: audience,
      AUTH0_CLIENT_ID: "mcp-client",
      AUTH0_CLIENT_SECRET: "secret",
      ...options.env,
    },
    () => loadSnippet(guide, index, { exportNames: ["server"], ...(options.rewrites && { rewrites: options.rewrites }) }),
  );
  const fastmcp = loaded.exports["server"] as FastMCP<Auth0Session>;
  await fastmcp.start({
    transportType: "httpStream",
    httpStream: { port, host: "127.0.0.1", stateless: true },
  });
  return {
    fastmcp,
    origin,
    audience,
    url: new URL(audience),
    async stop() {
      await fastmcp.stop();
      loaded.dispose();
    },
  };
}

export { createFastMcpAuth };
