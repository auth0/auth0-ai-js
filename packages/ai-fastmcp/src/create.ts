import type { IncomingMessage } from "node:http";
import { authenticateRequest } from "@auth0/ai-mcp";
import type { AuthenticateRequestOptions } from "@auth0/ai-mcp";
import { SessionBindings, MAX_SESSION_ID_LENGTH } from "./binding.js";
import { buildProtectedResource } from "./metadata.js";
import type { FastMcpOAuthOptions } from "./metadata.js";
import {
  assertRealm,
  assertSessionBinding,
  bearerOnly,
  defaultEndpoint,
  resolveClient,
  resolveEndpoint,
  resolveMetadataUrl,
} from "./options.js";
import type { FastMcpAuthOptions } from "./options.js";
import { challengeResponse, genericServerError, jsonResponse, sessionMismatchResponse } from "./responses.js";
import { normalizeRequiredScopes } from "./scopes.js";
import { createSession } from "./session.js";
import type { Auth0Session } from "./session.js";

/** What {@link createFastMcpAuth} returns: the two FastMCP options, to be spread into `new FastMCP({...})`. */
export interface FastMcpAuth {
  /**
   * FastMCP's `authenticate` hook. Resolves to an {@link Auth0Session}. Every failure of an HTTP
   * request is a thrown `Response` with the right status and a generic body; it never throws
   * anything else for a request. FastMCP calls it with no request for the stdio transport, which
   * this adapter does not support, and then it rejects with an `Error` that says so.
   */
  authenticate: (request: IncomingMessage) => Promise<Auth0Session>;
  /** FastMCP's `oauth` option: serves the RFC 9728 protected resource metadata. */
  oauth: FastMcpOAuthOptions;
  /**
   * The path FastMCP must serve the MCP route on: the `endpoint` option, else the path of the
   * resource, else `/mcp`. Pass it to `server.start({ httpStream: { endpoint: auth.endpoint } })`.
   * It is not enumerable, so `...auth` does not hand it to `new FastMCP({...})`.
   */
  readonly endpoint: `/${string}`;
}

const WELL_KNOWN_ROOT = "/.well-known/";
// mcp-proxy, which FastMCP runs on, opens a legacy SSE session on `GET /sse` and takes that session's
// messages on `POST /messages?sessionId=...`. FastMCP offers no option to turn the route off, and it
// authenticates only the first request: the message route never calls `authenticate`.
const LEGACY_SSE_OPEN_PATH = "/sse";
const MAX_WARNED_PATHS = 20;
const warnedPaths = new Set<string>();

/**
 * Writes one warning per process and distinct path when a request reaches `authenticate` on a path
 * that is not the configured endpoint, which means `server.start` was given another endpoint.
 * Only the path is read: the query string never reaches the log. It never changes a response.
 */
function warnOnUnexpectedPath(url: string | undefined, endpoint: string): void {
  try {
    if (url === undefined) return;
    const path = new URL(url, "http://localhost").pathname;
    if (path === endpoint || path.startsWith(WELL_KNOWN_ROOT)) return;
    if (warnedPaths.has(path) || warnedPaths.size >= MAX_WARNED_PATHS) return;
    warnedPaths.add(path);
    const shown = path.length > 100 ? `${path.slice(0, 97)}...` : path;
    console.warn(
      `[ai-fastmcp] A request arrived on "${shown}", but the configured endpoint is "${endpoint}", so the metadata URL in the challenge names "${endpoint}". Pass the same endpoint to server.start({ httpStream: { endpoint } }), for example endpoint: auth.endpoint.`,
    );
  } catch {
    // A warning must never change the response.
  }
}

/**
 * Whether the request opens a legacy SSE session, the same test mcp-proxy applies (method and
 * parsed path) before it calls `createServer`, and so `authenticate`.
 */
function opensLegacySseSession(req: IncomingMessage): boolean {
  if (req.method !== "GET" || req.url === undefined) return false;
  try {
    return new URL(req.url, "http://localhost").pathname === LEGACY_SSE_OPEN_PATH;
  } catch {
    return false;
  }
}

const STDIO_UNSUPPORTED =
  '@auth0/ai-fastmcp authenticates HTTP requests and cannot authenticate the stdio transport. Start the server with transportType: "httpStream".';
const DPOP_UNSUPPORTED = "DPoP is not supported by this server.";
const SENDER_CONSTRAINED_UNSUPPORTED = "DPoP-bound access tokens are not supported by this server.";

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Whether the bearer token claims a confirmation (`cnf`), which means a DPoP or mutual TLS key
 * is bound to it. The payload is read without verifying anything: a token that claims a binding
 * is refused whether or not its signature is good, so the check can only reject more.
 */
function claimsSenderConstraint(authorization: string | undefined): boolean {
  const match = /^Bearer +(\S+)$/i.exec(authorization ?? "");
  const parts = match?.[1]?.split(".");
  if (parts === undefined || parts.length !== 3) return false;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null && (payload as { cnf?: unknown }).cnf != null;
  } catch {
    return false;
  }
}

function safely(hook: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    const result: unknown = hook?.(error);
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
      (result as PromiseLike<unknown>).then(undefined, () => {});
    }
  } catch {
    // A failing observer must not change the response.
  }
}

/**
 * Creates the Auth0 authentication options for a FastMCP server.
 *
 * ```ts
 * const auth = createFastMcpAuth({ client });
 * const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });
 * ```
 *
 * `authenticate` verifies the Bearer token with the core client, enforces `requiredScopes`,
 * and returns an {@link Auth0Session}. A request that carries a `DPoP` header, or a token that
 * is bound to a key, is refused with 401: this adapter verifies Bearer tokens only. `oauth`
 * serves the protected resource metadata from the same resource and endpoint the challenges name.
 *
 * `GET /sse`, which would open a legacy SSE session, is refused with 404: mcp-proxy never
 * authenticates the messages posted for such a session, so the adapter allows none to exist.
 *
 * Do not combine the result with FastMCP's own `auth` option, which makes FastMCP an OAuth proxy
 * that issues its own tokens.
 *
 * Call it with no argument to read the client configuration from the environment.
 *
 * @throws {InvalidConfigurationError} When the client configuration is invalid or incomplete,
 * when `client` is combined with inline client options, when the client requires DPoP, when
 * `resource` differs from the client audience or cannot be derived, when the path of `resource`
 * ends in a slash or does not match `endpoint`, or when `endpoint`, `realm` or `sessionBinding`
 * is unusable.
 * @throws {TypeError} When an explicit `resource` is not an absolute URL.
 */
export function createFastMcpAuth(options: FastMcpAuthOptions = {}): FastMcpAuth {
  const { client, rest } = resolveClient(options);
  const bearerClient = bearerOnly(client);
  const explicitEndpoint = rest.endpoint === undefined ? undefined : resolveEndpoint(rest.endpoint);
  assertRealm(rest.realm);
  assertSessionBinding(rest.sessionBinding);
  const requiredScopes = normalizeRequiredScopes(rest.requiredScopes, "requiredScopes");

  const protectedResource = buildProtectedResource(bearerClient, { ...rest, requiredScopes });
  const resource = protectedResource.resource;
  const endpoint = (explicitEndpoint ?? defaultEndpoint(resource)) as `/${string}`;
  const metadataUrl = resolveMetadataUrl(resource, endpoint);

  const authOptions: AuthenticateRequestOptions = {
    client: bearerClient,
    resource,
    resourceMetadataUrl: metadataUrl,
    ...(requiredScopes.length > 0 && { requiredScopes }),
    ...(rest.realm !== undefined && { realm: rest.realm }),
    ...(rest.onError !== undefined && { onError: rest.onError }),
  };
  const bindings = rest.sessionBinding === false ? undefined : new SessionBindings(rest.sessionBinding);

  const reject = (status: number, description: string): Response =>
    challengeResponse({ status, error: "invalid_token", description, realm: rest.realm, metadataUrl });

  async function authenticateOrThrow(req: IncomingMessage): Promise<Auth0Session> {
    if (req.headers["dpop"] !== undefined) throw reject(401, DPOP_UNSUPPORTED);
    const authorization = singleHeader(req.headers["authorization"]);
    if (claimsSenderConstraint(authorization)) throw reject(401, SENDER_CONSTRAINED_UNSUPPORTED);

    const sessionId = singleHeader(req.headers["mcp-session-id"]);
    if (sessionId !== undefined && sessionId.length > MAX_SESSION_ID_LENGTH) {
      throw jsonResponse(400, { error: "invalid_request", error_description: "The session id is not valid." });
    }

    let request: Request;
    try {
      const headers = new Headers();
      if (authorization !== undefined) headers.set("authorization", authorization);
      request = new Request(resource, { headers });
    } catch {
      throw jsonResponse(400, { error: "invalid_request", error_description: "The request is malformed." });
    }

    const result = await authenticateRequest(request, authOptions);
    if (!result.ok) throw result.response;

    const { principal, mcpClient } = result.caller;
    if (bindings !== undefined && sessionId !== undefined && !bindings.accept(sessionId, principal.sub)) {
      throw sessionMismatchResponse();
    }
    return createSession(principal, mcpClient, rest.onError);
  }

  async function authenticate(req: IncomingMessage): Promise<Auth0Session> {
    // FastMCP calls the hook with no request for the stdio transport, which has no HTTP request to
    // read a token from. Say so plainly: FastMCP logs this message, and the session stays unset.
    if ((req as IncomingMessage | undefined) === undefined) throw new Error(STDIO_UNSUPPORTED);
    // Refused before any token work. Only this request can open a session on the route whose
    // messages are never authenticated, so refusing it leaves nothing for `POST /messages` to reach.
    if (opensLegacySseSession(req)) {
      throw jsonResponse(404, { error: "not_found", error_description: "Not found." });
    }
    warnOnUnexpectedPath(req.url, endpoint);
    try {
      return await authenticateOrThrow(req);
    } catch (error) {
      if (error instanceof Response) throw error;
      safely(rest.onError, error);
      throw genericServerError();
    }
  }

  const auth = { authenticate, oauth: { enabled: true as const, protectedResource } };
  // Not enumerable, so `...auth` in `new FastMCP({...})` does not pass an option FastMCP does not know.
  Object.defineProperty(auth, "endpoint", { value: endpoint, enumerable: false, writable: false, configurable: false });
  return auth as FastMcpAuth;
}
