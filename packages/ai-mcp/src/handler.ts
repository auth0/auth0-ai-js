import {
  AuthError,
  BearerMethod,
  InvalidConfigurationError,
  InvalidDpopProofError,
  InvalidRequestError,
  ProtectedResourceMetadataBuilder,
  VerifyAccessTokenError,
} from "@auth0/auth0-api-js";
import type { VerifyAccessTokenOptions } from "@auth0/auth0-api-js";
import { buildWwwAuthenticate, sanitizeChallengeValue } from "./challenge.js";
import type { ChallengeErrorCode, ChallengeScheme } from "./challenge.js";
import type { McpClient } from "./client.js";
import {
  DownscopedTokenError,
  InsufficientScopeError,
  UnauthenticatedError,
} from "./errors.js";
import { runWithRequestContext } from "./request-context.js";
import type { Principal, RequestScopedMcpClient } from "./types.js";

/**
 * What the downstream handler learns about the authenticated caller. The shape
 * matches the `AuthInfo` type of the MCP TypeScript SDK, so the object can be
 * handed to that SDK as is.
 */
export interface AuthInfo {
  /**
   * Always the empty string. The presented access token is intentionally
   * withheld so tool code cannot forward or log it by accident; tools should use
   * the request-scoped client (`getCallerMcpClient()`) to call downstream APIs.
   * Note that the MCP SDK transport still exposes the raw request headers through
   * `extra.requestInfo.headers`, so the `Authorization` header remains reachable
   * there.
   */
  token: string;
  /** The OAuth client the token was issued to. Empty when the token names none. */
  clientId: string;
  /** Scopes from the `scope` claim. */
  scopes: string[];
  /** Token expiry in epoch seconds. */
  expiresAt: number;
  /** The protected resource the token was issued for. */
  resource?: URL;
  /** Additional caller data: `sub`, and `orgId` and `permissions` when present. */
  extra?: Record<string, unknown>;
}

/**
 * DPoP handling of the {@link McpClient}. The handler reads it from
 * {@link McpClient.dpopMode} to decide which schemes it accepts and advertises.
 */
export type HandlerDpopMode = McpClient["dpopMode"];

/** Options for {@link createMcpHandler}. */
export interface McpHandlerOptions {
  /** Verifies tokens and creates the request-scoped client. */
  client: McpClient;
  /** Identifier of this MCP server. Absolute URL; used as the `resource` of the metadata document. */
  resource: string;
  /** Issuer URLs of the authorization servers that can issue tokens for this server. */
  authorizationServers: string[];
  /**
   * Serves the authenticated request. It runs inside the request context, so
   * `getCallerMcpClient()` and friends work in everything it starts.
   */
  handler: (request: Request, authInfo: AuthInfo) => Promise<Response>;
  /** Scopes every request must carry (all of them). Checked against the `scope` claim only. */
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
    /** Scopes to publish as `scopes_supported`. */
    scopesSupported?: string[];
    /** Human readable name to publish as `resource_name`. */
    resourceName?: string;
    /** Documentation URL to publish as `resource_documentation`. */
    resourceDocumentation?: string;
  };
  /**
   * Called with the raw error whenever the handler answers 500. The error never
   * reaches the response. A throwing hook, or one that returns a rejected promise, is ignored.
   */
  onError?: (error: unknown) => void;
}

const WELL_KNOWN_PRM = "/.well-known/oauth-protected-resource";
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;
const PROOF_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const NONCE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/;
const MAX_CREDENTIAL_LENGTH = 8192;

const DESCRIPTIONS: Record<ChallengeErrorCode, string> = {
  invalid_token: "The access token is invalid or has expired.",
  invalid_request: "The request is malformed.",
  insufficient_scope: "The access token does not include the required scope.",
  invalid_dpop_proof: "The DPoP proof is invalid.",
  use_dpop_nonce: "A server-provided DPoP nonce is required.",
};

const GENERIC_500_BODY =
  '{"error":"server_error","error_description":"Internal server error."}';

function genericServerError(): Response {
  return new Response(GENERIC_500_BODY, {
    status: 500,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

type Credentials =
  | { kind: "absent" }
  | { kind: "malformed"; scheme: ChallengeScheme }
  | { kind: "bearer"; token: string }
  | { kind: "dpop"; token: string; proof: string };

/** An error the handler turns into an HTTP response. */
interface Failure {
  status: number;
  error?: ChallengeErrorCode;
  /** Body `error` value for responses that carry no challenge error. */
  bodyError?: string;
  description: string;
  scope?: readonly string[];
  challenge: boolean;
  scheme?: ChallengeScheme;
  forward?: Array<[string, string]>;
}

/**
 * Reads the credential. A scheme the configured DPoP mode does not accept
 * (Bearer when DPoP is required, DPoP when it is disabled) and any unknown
 * scheme count as no credential: the client gets a challenge without an error
 * value, because RFC 6750 section 3.1 reserves error values for requests that
 * did carry the authentication the server supports.
 */
function extractCredentials(
  request: Request,
  mode: HandlerDpopMode,
): Credentials {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    return { kind: "absent" };
  }
  const [rawScheme, token, ...rest] = authorization.split(/ +/);
  const scheme = rawScheme?.toLowerCase();
  if (scheme === "bearer" && mode !== "required") {
    if (
      rest.length > 0 ||
      token === undefined ||
      token.length > MAX_CREDENTIAL_LENGTH ||
      !TOKEN_PATTERN.test(token)
    ) {
      return { kind: "malformed", scheme: "Bearer" };
    }
    return { kind: "bearer", token };
  }
  if (scheme === "dpop" && mode !== "disabled") {
    const proof = request.headers.get("dpop");
    if (
      rest.length > 0 ||
      token === undefined ||
      token.length > MAX_CREDENTIAL_LENGTH ||
      !TOKEN_PATTERN.test(token) ||
      proof === null ||
      proof.length > MAX_CREDENTIAL_LENGTH ||
      !PROOF_PATTERN.test(proof)
    ) {
      return { kind: "malformed", scheme: "DPoP" };
    }
    return { kind: "dpop", token, proof };
  }
  return { kind: "absent" };
}

function schemesFor(mode: HandlerDpopMode): ChallengeScheme[] {
  if (mode === "required") return ["DPoP"];
  if (mode === "disabled") return ["Bearer"];
  return ["Bearer", "DPoP"];
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Headers = new Headers(),
): Response {
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

/** Header values from a core error that are safe to put on a response (RFC 9449 nonce syntax). */
function nonceValues(error: AuthError): Array<[string, string]> {
  const headers = error.headers;
  if (headers === undefined || headers === null) return [];
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "dpop-nonce",
  );
  if (entry === undefined) return [];
  const values: unknown[] = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
  return values
    .filter(
      (value): value is string =>
        typeof value === "string" && NONCE_PATTERN.test(value),
    )
    .map((value): [string, string] => ["DPoP-Nonce", value]);
}

function statusToError(
  status: number | undefined,
): ChallengeErrorCode | undefined {
  if (status === 400) return "invalid_request";
  if (status === 401) return "invalid_token";
  if (status === 403) return "insufficient_scope";
  return undefined;
}

function missingFrom(
  required: readonly string[],
  held: readonly string[],
): string[] {
  const have = new Set(held);
  return required.filter((scope) => !have.has(scope));
}

function authFailure(
  status: number,
  code: ChallengeErrorCode,
  extra: Partial<Failure> = {},
): Failure {
  return {
    status,
    error: code,
    description: DESCRIPTIONS[code],
    challenge: true,
    ...extra,
  };
}

const SERVER_FAILURE: Failure = {
  status: 500,
  bodyError: "server_error",
  description: "Internal server error.",
  challenge: false,
};

/**
 * Maps an error from credential extraction, verification, `withToken` or the
 * scope gate. Core errors keep their status class; everything else is a 500.
 */
function classifyAuthentication(error: unknown): Failure {
  if (error instanceof UnauthenticatedError) {
    return authFailure(401, "invalid_token");
  }
  if (error instanceof AuthError) {
    const forward = nonceValues(error);
    const causeCode = (error.cause as { code?: unknown } | undefined)?.code;
    if (error.code === "use_dpop_nonce" || causeCode === "use_dpop_nonce") {
      // Without a usable nonce the client cannot retry, so report the proof as invalid.
      return forward.length > 0
        ? authFailure(401, "use_dpop_nonce", { scheme: "DPoP", forward })
        : authFailure(401, "invalid_dpop_proof", { scheme: "DPoP" });
    }
    if (error instanceof InvalidDpopProofError) {
      return authFailure(401, "invalid_dpop_proof", {
        scheme: "DPoP",
        forward,
      });
    }
    if (error instanceof InvalidRequestError) {
      return authFailure(400, "invalid_request", { forward });
    }
    if (error instanceof VerifyAccessTokenError) {
      return authFailure(401, "invalid_token", { forward });
    }
    const code = statusToError(error.statusCode);
    if (code !== undefined && error.statusCode !== undefined) {
      return authFailure(error.statusCode, code, { forward });
    }
  }
  return SERVER_FAILURE;
}

/**
 * Maps an error thrown by the downstream handler. Only the wrapper's own errors
 * become client-facing failures; anything else, including core errors such as a
 * failed token exchange, is an internal error and must not turn into a challenge.
 * These errors only reach this function when they escape the downstream handler.
 * Under `createMcpSdkHandler` the MCP SDK catches errors thrown by tools first, so
 * a downscoped exchange there becomes an `isError` tool result with HTTP 200.
 */
function classifyDownstream(error: unknown, held: readonly string[]): Failure {
  if (error instanceof InsufficientScopeError) {
    return authFailure(403, "insufficient_scope", {
      scope: missingFrom(error.requiredScopes, held),
    });
  }
  if (error instanceof DownscopedTokenError) {
    return authFailure(403, "insufficient_scope");
  }
  if (error instanceof UnauthenticatedError) {
    return authFailure(401, "invalid_token");
  }
  return SERVER_FAILURE;
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
 * @throws {TypeError} When `resource` is not an absolute URL.
 * @throws {InvalidConfigurationError} When `metadata.path` is not a normalized absolute path,
 * or `realm` is empty, whitespace-only or contains characters a challenge cannot carry.
 */
export function createMcpHandler(
  options: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  const resourceUrl = new URL(options.resource);
  if (
    options.realm !== undefined &&
    (typeof options.realm !== "string" ||
      options.realm.trim() === "" ||
      sanitizeChallengeValue(options.realm) !== options.realm)
  ) {
    throw new InvalidConfigurationError(
      'Invalid configuration: "realm" must be a non-empty string without quotes, backslashes or control characters.',
    );
  }
  const dpop = options.client.dpopMode;
  const schemes = schemesFor(dpop);
  const resourcePath =
    resourceUrl.pathname === "/" ? "" : resourceUrl.pathname.replace(/\/$/, "");
  if (options.metadata?.path !== undefined) {
    validateMetadataPath(options.metadata.path, resourceUrl.origin);
  }
  const metadataPath =
    options.metadata?.path ?? `${WELL_KNOWN_PRM}${resourcePath}`;
  const metadataUrl = new URL(metadataPath, resourceUrl.origin).href;
  const requiredScopes = [...new Set(options.requiredScopes ?? [])];

  const builder = new ProtectedResourceMetadataBuilder(
    options.resource,
    options.authorizationServers,
  );
  builder.withBearerMethodsSupported([BearerMethod.HEADER]);
  if (dpop !== "disabled") builder.withDpopSigningAlgValuesSupported(["ES256"]);
  if (dpop === "required") builder.withDpopBoundAccessTokensRequired(true);
  const meta = options.metadata;
  if (meta?.scopesSupported !== undefined)
    builder.withScopesSupported(meta.scopesSupported);
  if (meta?.resourceName !== undefined)
    builder.withResourceName(meta.resourceName);
  if (meta?.resourceDocumentation !== undefined)
    builder.withResourceDocumentation(meta.resourceDocumentation);
  const metadataBody = JSON.stringify(builder.build().toJSON());

  function respond(failure: Failure, presented?: ChallengeScheme): Response {
    const headers = new Headers();
    if (failure.challenge) {
      const values = buildWwwAuthenticate({
        schemes,
        error: failure.error,
        errorDescription:
          failure.error === undefined ? undefined : failure.description,
        scope: failure.scope,
        realm: options.realm,
        resourceMetadata: metadataUrl,
        errorScheme: failure.scheme ?? presented,
      });
      for (const value of values) headers.append("www-authenticate", value);
    }
    for (const [name, value] of failure.forward ?? [])
      headers.append(name, value);
    return jsonResponse(
      failure.status,
      {
        error: failure.error ?? failure.bodyError,
        error_description: failure.description,
      },
      headers,
    );
  }

  function report(error: unknown): void {
    try {
      const result: unknown = options.onError?.(error);
      if (isThenable(result)) {
        // An async observer that rejects must not surface as an unhandled rejection.
        result.then(undefined, () => {});
      }
    } catch {
      // A failing observer must not change the response.
    }
  }

  /** Builds the failure response. Nothing in here may escape to the framework. */
  function fail(
    classify: () => Failure,
    error: unknown,
    presented?: ChallengeScheme,
  ): Response {
    try {
      const failure = classify();
      if (failure.status === 500) report(error);
      return respond(failure, presented);
    } catch {
      report(error);
      return genericServerError();
    }
  }

  return async function handle(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      // Same treatment as other malformed requests: a well-formed 400 challenge.
      return fail(() => authFailure(400, "invalid_request"), undefined);
    }
    if (url.pathname === metadataPath) {
      if (request.method !== "GET") {
        return new Response(null, { status: 405, headers: { allow: "GET" } });
      }
      return new Response(metadataBody, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    const credentials = extractCredentials(request, dpop);
    if (credentials.kind === "absent") {
      return fail(
        () => ({
          status: 401,
          bodyError: "unauthorized",
          description: "Authentication is required.",
          challenge: true,
        }),
        undefined,
      );
    }
    if (credentials.kind === "malformed") {
      return fail(
        () => authFailure(400, "invalid_request"),
        undefined,
        credentials.scheme,
      );
    }

    const presented: ChallengeScheme =
      credentials.kind === "dpop" ? "DPoP" : "Bearer";
    let principal: Principal;
    let mcpClient: RequestScopedMcpClient;
    try {
      const verifyOptions: VerifyAccessTokenOptions =
        credentials.kind === "dpop"
          ? {
              accessToken: credentials.token,
              scheme: "dpop",
              dpopProof: credentials.proof,
              httpMethod: request.method,
              httpUrl: request.url,
            }
          : { accessToken: credentials.token, scheme: "bearer" };
      const caller = await options.client.verifyAccessToken(verifyOptions);
      principal = caller.principal;

      const missing = missingFrom(requiredScopes, principal.scopes);
      if (missing.length > 0) {
        return respond(
          authFailure(403, "insufficient_scope", { scope: missing }),
          presented,
        );
      }
      mcpClient = options.client.withToken(caller);
    } catch (error) {
      return fail(() => classifyAuthentication(error), error, presented);
    }

    const authInfo: AuthInfo = {
      token: '',
      clientId: principal.clientId ?? "",
      scopes: [...principal.scopes],
      expiresAt: principal.expiresAt,
      resource: resourceUrl,
      extra: {
        sub: principal.sub,
        ...(principal.orgId !== null && { orgId: principal.orgId }),
        ...(principal.permissions !== null && {
          permissions: [...principal.permissions],
        }),
      },
    };
    try {
      return await runWithRequestContext({ principal, mcpClient }, () =>
        options.handler(request, authInfo),
      );
    } catch (error) {
      return fail(
        () => classifyDownstream(error, principal.scopes),
        error,
        presented,
      );
    }
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
