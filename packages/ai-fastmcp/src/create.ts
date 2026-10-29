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
  resolveClient,
  resolveEndpoint,
  resolveMetadataUrl,
} from "./options.js";
import type { FastMcpAuthOptions } from "./options.js";
import { challengeResponse, genericServerError, jsonResponse, sessionMismatchResponse } from "./responses.js";
import { createSession } from "./session.js";
import type { Auth0Session } from "./session.js";

/** What {@link createFastMcpAuth} returns: the two FastMCP options, to be spread into `new FastMCP({...})`. */
export interface FastMcpAuth {
  /**
   * FastMCP's `authenticate` hook. Resolves to an {@link Auth0Session}. Every failure is a thrown
   * `Response` with the right status and a generic body; it never throws anything else.
   */
  authenticate: (request: IncomingMessage) => Promise<Auth0Session>;
  /** FastMCP's `oauth` option: serves the RFC 9728 protected resource metadata. */
  oauth: FastMcpOAuthOptions;
}

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
 * Do not combine the result with FastMCP's own `auth` option, which makes FastMCP an OAuth proxy
 * that issues its own tokens.
 *
 * @throws {InvalidConfigurationError} When the client configuration is invalid or incomplete,
 * when `client` is combined with inline client options, when the client requires DPoP, when
 * `resource` differs from the client audience or cannot be derived, when the path of `resource`
 * does not match `endpoint`, or when `endpoint`, `realm` or `sessionBinding` is unusable.
 * @throws {TypeError} When an explicit `resource` is not an absolute URL.
 */
export function createFastMcpAuth(options: FastMcpAuthOptions): FastMcpAuth {
  const { client, rest } = resolveClient(options);
  const bearerClient = bearerOnly(client);
  const endpoint = resolveEndpoint(rest.endpoint);
  assertRealm(rest.realm);
  assertSessionBinding(rest.sessionBinding);

  const protectedResource = buildProtectedResource(bearerClient, rest);
  const resource = protectedResource.resource;
  const origin = new URL(resource).origin;
  const metadataUrl = resolveMetadataUrl(resource, endpoint);

  const authOptions: AuthenticateRequestOptions = {
    client: bearerClient,
    resource,
    resourceMetadataUrl: metadataUrl,
    ...(rest.requiredScopes !== undefined && { requiredScopes: rest.requiredScopes }),
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
      request = new Request(new URL(req.url ?? "/", origin), { headers });
    } catch {
      throw jsonResponse(400, { error: "invalid_request", error_description: "The request is malformed." });
    }

    const result = await authenticateRequest(request, authOptions);
    if (!result.ok) throw result.response;

    const { principal, mcpClient } = result.caller;
    if (bindings !== undefined && sessionId !== undefined && !bindings.accept(sessionId, principal.sub)) {
      throw sessionMismatchResponse();
    }
    return createSession(principal, mcpClient);
  }

  async function authenticate(req: IncomingMessage): Promise<Auth0Session> {
    try {
      return await authenticateOrThrow(req);
    } catch (error) {
      if (error instanceof Response) throw error;
      safely(rest.onError, error);
      throw genericServerError();
    }
  }

  return { authenticate, oauth: { enabled: true, protectedResource } };
}
