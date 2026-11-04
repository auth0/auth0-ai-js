import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import {
  WELL_KNOWN_PRM,
  authFailure,
  classifyDownstream,
  createAuthenticator,
  resolveResource,
  resourcePathOf,
} from "./authenticate.js";
import type { AuthInfo } from "./authenticate.js";
import { createMcpClient } from "./client.js";
import type { McpClient } from "./client.js";
import { resolveMcpClientOptions } from "./env.js";
import { buildProtectedResourceMetadata, resolveAuthorizationServers } from "./metadata.js";
import type { McpClientOptions } from "./types.js";

export type { AuthInfo, HandlerDpopMode } from "./authenticate.js";

/**
 * The client part of the handler options. Choose one of three ways to configure it:
 *
 * 1. `client`: a client you built with `createMcpClient`.
 * 2. Inline client options (`domain`, `audience`, `clientId`, `clientSecret`, `tokenStore` and
 *    the other {@link McpClientOptions}): the handler builds the client for you. Values you leave
 *    out of `domain`, `audience`, `clientId` and `clientSecret` are read from the environment
 *    variables `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`.
 * 3. Neither: all of the above come from the environment.
 *
 * Passing `client` together with any inline client option throws `InvalidConfigurationError`.
 */
export type McpHandlerClientConfig =
  | ({ client: McpClient } & { [K in keyof McpClientOptions]?: never })
  | ({ client?: undefined } & Partial<McpClientOptions>);

/** Options for {@link createMcpHandler} other than the client configuration. */
export interface McpHandlerBaseOptions {
  /**
   * Identifier of this MCP server: the absolute URL clients use to reach it,
   * published as the `resource` of the RFC 9728 metadata document and sent back by
   * clients as the RFC 8707 `resource` parameter.
   *
   * Defaults to the client audience when that is an absolute `http` or `https` URL
   * without a fragment or credentials, which is the recommended setup. When you set it,
   * it must equal the client audience: the check is an exact string match after
   * lower-casing the scheme and the host only, so a trailing slash counts as a
   * difference. `createMcpHandler` throws `InvalidConfigurationError` on a mismatch,
   * because tokens for any other audience are rejected.
   */
  resource?: string;
  /**
   * Issuer URLs of the authorization servers that can issue tokens for this server.
   * Each entry must match the `iss` value clients see.
   *
   * Defaults to `["https://<domain>/"]`, built from `client.domain` (the scheme is
   * optional, the host is lower-cased). Set it yourself to advertise several
   * authorization servers, an issuer that does not look like that, or when the
   * client does not declare a single domain.
   */
  authorizationServers?: string[];
  /**
   * Serves the authenticated request. It runs inside the request context, so
   * `getCallerMcpClient()` and friends work in everything it starts.
   */
  handler: (request: Request, authInfo: AuthInfo) => Promise<Response>;
  /**
   * Scopes every request must carry (all of them). Checked against the `scope` claim only.
   * Like `requireScopes`, each entry is split on whitespace, so `"read write"` names two
   * scopes, and a blank or non-string entry is a configuration error. They are also sent as
   * the `scope` of the challenge for a request without a credential, and published as
   * `metadata.scopesSupported` unless you set that yourself.
   */
  requiredScopes?: readonly string[];
  /** Protection space reported as `realm` in challenges. */
  realm?: string;
  /** Settings for the RFC 9728 metadata route. */
  metadata?: {
    /**
     * Path of the route. Defaults to the RFC 9728 well-known path for `resource`:
     * `/.well-known/oauth-protected-resource` followed by the path of `resource`.
     * A custom path must start with `/`, carry no query or fragment and be
     * normalized (no dot segments, no characters that need percent-encoding);
     * `createMcpHandler` throws `InvalidConfigurationError` otherwise. The
     * `resource_metadata` value in challenges is always this route's absolute URL.
     *
     * The route sends no CORS headers; add them in your framework if browser-based
     * clients must read the document.
     */
    path?: string;
    /**
     * Scopes to publish as `scopes_supported`. Defaults to `requiredScopes` when that is set,
     * so a client that takes its scopes from the metadata asks for the ones every request needs.
     */
    scopesSupported?: string[];
    /** Human readable name to publish as `resource_name`. */
    resourceName?: string;
    /** Documentation URL to publish as `resource_documentation`. */
    resourceDocumentation?: string;
  };
  /**
   * Called with the raw error whenever the handler answers 500. The error never
   * reaches the response. A throwing hook, or one that returns a rejected promise, is ignored.
   *
   * It is not called for authentication failures. In particular, a failed discovery or JWKS
   * fetch of the authorization server is reported by the core library as an invalid token, so
   * during an outage of the tenant the client gets a 401 `invalid_token` and this hook stays
   * silent. A 503 for that case, with a call to this hook, needs a change in the core library.
   */
  onError?: (error: unknown) => void;
}

/** Options for {@link createMcpHandler}. */
export type McpHandlerOptions = McpHandlerClientConfig & McpHandlerBaseOptions;

const CLIENT_OPTION_NAMES = [
  "domain",
  "audience",
  "clientId",
  "clientSecret",
  "tokenStore",
  "scopeMatching",
  "organizationPolicy",
  "organizationId",
  "dpop",
  "requestTimeoutMs",
  "apiClient",
] as const satisfies ReadonlyArray<keyof McpClientOptions>;

/**
 * Splits handler options into the client and everything else. The client is the given
 * `client`, or one built from the inline options and the environment.
 *
 * @throws {InvalidConfigurationError} When `client` is combined with inline client options,
 * when a required value is missing from both the options and the environment, or when the
 * client options are invalid.
 * @internal
 */
export function resolveHandlerClient<T extends McpHandlerClientConfig>(
  options: T,
): { client: McpClient; rest: Omit<T, "client" | (typeof CLIENT_OPTION_NAMES)[number]> } {
  const bag = options as Record<string, unknown>;
  const inline = CLIENT_OPTION_NAMES.filter((name) => bag[name] !== undefined);
  const rest: Record<string, unknown> = { ...bag };
  delete rest["client"];
  for (const name of CLIENT_OPTION_NAMES) delete rest[name];
  if (bag["client"] !== undefined) {
    if (inline.length > 0) {
      throw new InvalidConfigurationError(
        `Invalid configuration: "client" cannot be combined with ${inline.map((n) => `"${n}"`).join(", ")}. Pass either a client or client options.`,
      );
    }
    return { client: bag["client"] as McpClient, rest: rest as never };
  }
  const explicit: Record<string, unknown> = {};
  for (const name of inline) explicit[name] = bag[name];
  return {
    client: createMcpClient(resolveMcpClientOptions(explicit as Partial<McpClientOptions>)),
    rest: rest as never,
  };
}

/**
 * Applies the defaults for `resource` and `authorizationServers`. Explicit values
 * are returned unchanged, except that an explicit `resource` must equal the client
 * audience. A missing value that cannot be derived from the client is a
 * configuration error that names the option to set.
 *
 * @throws {InvalidConfigurationError} When a default is needed and the client does
 * not provide a usable audience or domain, or when `resource` differs from the audience.
 * @internal
 */
export function resolveHandlerEndpoints(
  client: McpClient,
  options: Pick<McpHandlerBaseOptions, "resource" | "authorizationServers">,
): { resource: string; authorizationServers: string[] } {
  return {
    resource: resolveResource(client, options.resource),
    authorizationServers: resolveAuthorizationServers(client, options.authorizationServers),
  };
}

function validateMetadataPath(path: string, origin: string): void {
  let normalized: string | undefined;
  if (path.startsWith("/")) {
    try {
      normalized = new URL(path, origin).pathname;
    } catch {
      normalized = undefined;
    }
  }
  if (normalized !== path) {
    throw new InvalidConfigurationError(
      'Invalid configuration: "metadata.path" must be an absolute, normalized path without query or fragment.',
    );
  }
}

/**
 * Creates a function that authenticates MCP HTTP requests and hands them to your
 * handler. It takes a standard `Request` and returns a `Response`, so it plugs
 * into any runtime or framework that speaks the Fetch API.
 *
 * Per request it serves the RFC 9728 metadata document, or extracts a Bearer or
 * DPoP credential, verifies it, enforces `requiredScopes`, binds the caller into
 * the request context and calls `handler`. Accepted schemes, challenges and the
 * metadata DPoP declaration follow `client.dpopMode`. Authentication failures
 * become RFC 6750 responses with a generic body and a rebuilt `WWW-Authenticate`
 * challenge; verifier messages are never echoed. Errors thrown by `handler` map
 * to a client-facing failure only when they are the wrapper's
 * `UnauthenticatedError`, `InsufficientScopeError` or `DownscopedTokenError`;
 * every other error becomes a generic 500 without a challenge.
 *
 * DPoP `htu` is checked against `request.url`. Behind a proxy that rewrites the
 * URL, pass a `Request` whose URL is the public one the client used; the handler
 * has no option to override it. The metadata route sends no CORS headers.
 *
 * Known limitation: when the tenant's discovery document or key set cannot be fetched, the
 * core library reports the token as invalid, so the handler answers 401 `invalid_token`
 * and does not call `onError`. A client usually treats a 401 as a reason to authorize again,
 * so during such an outage a user may be asked to sign in again although the token is fine.
 * Answering 503 for this case needs a change in the core library.
 *
 * `resource` and `authorizationServers` are optional. They default to the client's
 * audience and to `https://<domain>/`; see {@link McpHandlerBaseOptions}. An explicit
 * `resource` must equal the client audience. The client itself is configured through
 * `client`, inline client options or the environment; see {@link McpHandlerClientConfig}.
 *
 * The metadata document is served for GET and HEAD at the RFC 9728 path derived from
 * `resource`, which is where challenges point. When `resource` has no path, that is the root
 * `/.well-known/oauth-protected-resource`; for a resource with a path the root route is not
 * served, because the document would name a resource other than the one the URL stands for.
 * Other methods get 405 with `Allow: GET, HEAD`, and there is no CORS handling.
 *
 * @throws {TypeError} When an explicit `resource` is not an absolute URL and the audience comparison
 * does not catch it, that is, when the audience is the same non-URL string or the client declares no
 * audience. Against a URL audience, a non-URL `resource` is an `InvalidConfigurationError`.
 * @throws {InvalidConfigurationError} When `client` is combined with inline client options,
 * when a required client value is missing from both the options and the environment,
 * when an explicit `resource` differs from the client audience,
 * when `resource` is omitted and the client
 * audience is not an absolute http or https URL, when `authorizationServers` is omitted
 * and the client does not declare a usable tenant domain, when `metadata.path` is not a normalized absolute path,
 * `requiredScopes` has a blank or non-string entry, or `realm` is empty, whitespace-only or contains
 * characters a challenge cannot carry.
 */
export function createMcpHandler(
  options: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  const { client, rest } = resolveHandlerClient(options);
  const { resource, authorizationServers } = resolveHandlerEndpoints(client, rest);
  const resourceUrl = new URL(resource);
  const resourcePath = resourcePathOf(resourceUrl);
  if (rest.metadata?.path !== undefined) {
    validateMetadataPath(rest.metadata.path, resourceUrl.origin);
  }
  // The RFC 9728 route is the primary one and the only one challenges point at. The root route
  // is served only for a resource without a path: RFC 9728 section 3.3 requires `resource` to
  // equal the identifier the well-known URL was derived from, and the root URL is derived from
  // the bare origin, so a document naming a resource with a path would not match it.
  const metadataPath = rest.metadata?.path ?? `${WELL_KNOWN_PRM}${resourcePath}`;
  const metadataPaths = new Set([metadataPath]);
  if (resourcePath === "") metadataPaths.add(WELL_KNOWN_PRM);
  const authenticator = createAuthenticator({
    client,
    resource,
    requiredScopes: rest.requiredScopes,
    realm: rest.realm,
    resourceMetadataUrl: new URL(metadataPath, resourceUrl.origin).href,
    onError: rest.onError,
  });
  const metadataBody = JSON.stringify(
    buildProtectedResourceMetadata({
      client,
      resource,
      authorizationServers,
      // Without an explicit list, publish the scopes every request must carry, so a client
      // that reads `scopes_supported` has something to ask for.
      scopesSupported:
        rest.metadata?.scopesSupported ??
        (authenticator.requiredScopes.length > 0 ? authenticator.requiredScopes : undefined),
      resourceName: rest.metadata?.resourceName,
      resourceDocumentation: rest.metadata?.resourceDocumentation,
    }),
  );
  const metadataLength = new TextEncoder().encode(metadataBody).byteLength;
  const { fail } = authenticator.responder;

  return async function handle(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      // Same treatment as other malformed requests: a well-formed 400 challenge.
      return fail(() => authFailure(400, "invalid_request"), undefined);
    }
    if (metadataPaths.has(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, HEAD", "cache-control": "no-store" },
        });
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
      };
      // HEAD answers like GET without the body, so it carries the length GET would send.
      if (request.method === "HEAD") {
        headers["content-length"] = String(metadataLength);
        return new Response(null, { status: 200, headers });
      }
      return new Response(metadataBody, { status: 200, headers });
    }

    const result = await authenticator.authenticate(request);
    if (!result.ok) return result.response;
    const { authInfo } = result;
    try {
      return await result.run(() => rest.handler(request, authInfo));
    } catch (error) {
      return fail(
        () => classifyDownstream(error, authenticator.requiredScopes),
        error,
        result.scheme,
      );
    }
  };
}
