import {
  AuthError,
  InvalidConfigurationError,
  InvalidDpopProofError,
  InvalidRequestError,
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
import type { Principal, RequestContext, RequestScopedMcpClient } from "./types.js";

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
   * Note that the MCP SDK still exposes the original request to tool callbacks
   * as `ctx.http.req`, so the `Authorization` header remains reachable there.
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

export function genericServerError(): Response {
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
export interface Failure {
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

export function schemesFor(mode: HandlerDpopMode): ChallengeScheme[] {
  if (mode === "required") return ["DPoP"];
  if (mode === "disabled") return ["Bearer"];
  return ["Bearer", "DPoP"];
}

export function jsonResponse(
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

export function missingFrom(
  required: readonly string[],
  held: readonly string[],
): string[] {
  const have = new Set(held);
  return required.filter((scope) => !have.has(scope));
}

export function authFailure(
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
export function classifyDownstream(error: unknown, held: readonly string[]): Failure {
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

/**
 * The audience as a resource URL, or `undefined` when it cannot be one: not a
 * string, not an absolute http or https URL, or carrying a fragment or
 * credentials. The value is returned unchanged so it keeps matching the API
 * identifier byte for byte.
 */
function resourceFromAudience(audience: unknown): string | undefined {
  if (typeof audience !== "string" || audience === "" || audience !== audience.trim()) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(audience);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    audience.includes("#")
  ) {
    return undefined;
  }
  return audience;
}

/**
 * Lower-cases the scheme and the host of an absolute URL string and leaves every other
 * character untouched, so two spellings of the same origin compare equal while a path,
 * query or trailing slash difference stays visible.
 */
function canonicalizeOrigin(value: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(value);
  if (match === null) return value;
  const [, scheme, authority, rest] = match;
  const at = authority!.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority!.slice(0, at + 1);
  const hostAndPort = at === -1 ? authority! : authority!.slice(at + 1);
  return `${scheme!.toLowerCase()}://${userinfo}${hostAndPort.toLowerCase()}${rest}`;
}

/**
 * Returns the protected resource identifier a server advertises and puts in
 * {@link AuthInfo.resource}, and checks it against the client audience.
 *
 * Without an explicit `resource` the client audience is used, which must be an absolute
 * http or https URL. With an explicit `resource` that differs from a known audience this
 * throws, because access tokens for any other audience are rejected, so advertising a
 * different resource would send clients to a server that refuses their tokens. The
 * comparison is an exact string match after lower-casing the scheme and the host only.
 * A trailing slash counts as a difference, and the message says so when it is the only one.
 *
 * @param client - The client whose `audience` is the reference.
 * @param resource - The explicit resource, if any.
 * @returns The resource identifier.
 * @throws {InvalidConfigurationError} When no resource can be derived, or when `resource`
 * and the client audience are both known and differ.
 */
export function resolveResource(client: McpClient, resource: string | undefined): string {
  if (resource === undefined) {
    const derived = resourceFromAudience(client.audience);
    if (derived === undefined) {
      throw new InvalidConfigurationError(
        'Invalid configuration: the handler needs the public URL of this MCP server as its resource identifier, but the client audience is missing or is not an absolute http or https URL without a fragment or credentials. Set the audience to that URL, or pass it as "resource" when the client declares no audience.',
      );
    }
    return derived;
  }
  const audience = client.audience;
  if (audience !== undefined && canonicalizeOrigin(resource) !== canonicalizeOrigin(audience)) {
    const a = canonicalizeOrigin(resource);
    const b = canonicalizeOrigin(audience);
    const slashOnly = a.replace(/\/$/, "") === b.replace(/\/$/, "");
    throw new InvalidConfigurationError(
      'Invalid configuration: "resource" must equal the client audience, because access tokens for any other audience are rejected.' +
        (slashOnly ? " The two differ only by a trailing slash, which counts as a difference." : "") +
        ' Omit "resource" to use the audience.',
    );
  }
  return resource;
}

/** The RFC 9728 well-known path prefix of the protected resource metadata document. */
export const WELL_KNOWN_PRM = "/.well-known/oauth-protected-resource";

/** Builds failure responses and reports internal errors. Nothing in here may throw. */
export interface FailureResponder {
  respond(failure: Failure, presented?: ChallengeScheme): Response;
  fail(classify: () => Failure, error: unknown, presented?: ChallengeScheme): Response;
}

export function createFailureResponder(settings: {
  schemes: readonly ChallengeScheme[];
  realm: string | undefined;
  metadataUrl: string;
  onError: ((error: unknown) => void) | undefined;
}): FailureResponder {
  function respond(failure: Failure, presented?: ChallengeScheme): Response {
    const headers = new Headers();
    if (failure.challenge) {
      const values = buildWwwAuthenticate({
        schemes: settings.schemes,
        error: failure.error,
        errorDescription:
          failure.error === undefined ? undefined : failure.description,
        scope: failure.scope,
        realm: settings.realm,
        resourceMetadata: settings.metadataUrl,
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
      const result: unknown = settings.onError?.(error);
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

  return { respond, fail };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Options for {@link authenticateRequest}. */
export interface AuthenticateRequestOptions {
  /** Verifies tokens and creates the request-scoped client. */
  client: McpClient;
  /**
   * Identifier of this MCP server, reported as {@link AuthInfo.resource} and used to derive the
   * metadata URL named in challenges. Defaults to `client.audience` when that is an absolute
   * `http` or `https` URL. When set, it must equal the client audience (see {@link resolveResource}).
   */
  resource?: string;
  /** Scopes every request must carry (all of them). Checked against the `scope` claim only. */
  requiredScopes?: readonly string[];
  /** Protection space reported as `realm` in challenges. */
  realm?: string;
  /**
   * Absolute URL of the RFC 9728 metadata document named in the `resource_metadata` challenge
   * parameter. Defaults to the well-known URL for `resource`: the well-known path followed by the
   * path of `resource`, on its origin.
   */
  resourceMetadataUrl?: string;
  /**
   * Called with the raw error whenever the failure response is a 500. The error never reaches
   * the response. A throwing hook, or one that returns a rejected promise, is ignored.
   */
  onError?: (error: unknown) => void;
}

/** The outcome of {@link authenticateRequest} for an authenticated request. */
export interface AuthenticatedRequest {
  ok: true;
  /** What downstream code learns about the caller. The same shape the handler passes on. */
  authInfo: AuthInfo;
  /** The caller's principal and a client bound to the caller's verified token. */
  caller: RequestContext;
  /** The scheme the request authenticated with. Use it as the error scheme of a failure challenge. */
  scheme: ChallengeScheme;
  /**
   * Runs `fn` with the caller bound as the current request context, so
   * `getCallerMcpClient()` and friends work in everything `fn` starts. Errors from `fn`
   * propagate unchanged.
   */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

/** The outcome of {@link authenticateRequest} for a rejected request. */
export interface RejectedRequest {
  ok: false;
  /**
   * A ready response with the right status, a generic body and, for authentication failures,
   * a `WWW-Authenticate` challenge. Return it to the client as is.
   */
  response: Response;
}

/** The outcome of {@link authenticateRequest}. */
export type AuthenticateResult = AuthenticatedRequest | RejectedRequest;

/** What {@link createAuthenticator} resolves once, at construction. */
export interface Authenticator {
  authenticate(request: Request): Promise<AuthenticateResult>;
  resource: string;
  resourceUrl: URL;
  metadataUrl: string;
  schemes: ChallengeScheme[];
  responder: FailureResponder;
}

/**
 * Resolves the settings of an authenticator once, so a handler validates its configuration
 * at construction instead of on every request.
 * @internal
 */
export function createAuthenticator(options: AuthenticateRequestOptions): Authenticator {
  const resource = resolveResource(options.client, options.resource);
  const resourceUrl = new URL(resource);
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
  const metadataUrl =
    options.resourceMetadataUrl ??
    new URL(`${WELL_KNOWN_PRM}${resourcePathOf(resourceUrl)}`, resourceUrl.origin).href;
  const requiredScopes = [...new Set(options.requiredScopes ?? [])];
  const responder = createFailureResponder({
    schemes,
    realm: options.realm,
    metadataUrl,
    onError: options.onError,
  });

  async function authenticate(request: Request): Promise<AuthenticateResult> {
    const credentials = extractCredentials(request, dpop);
    if (credentials.kind === "absent") {
      return {
        ok: false,
        response: responder.fail(
          () => ({
            status: 401,
            bodyError: "unauthorized",
            description: "Authentication is required.",
            challenge: true,
          }),
          undefined,
        ),
      };
    }
    if (credentials.kind === "malformed") {
      return {
        ok: false,
        response: responder.fail(
          () => authFailure(400, "invalid_request"),
          undefined,
          credentials.scheme,
        ),
      };
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
        return {
          ok: false,
          response: responder.respond(
            authFailure(403, "insufficient_scope", { scope: missing }),
            presented,
          ),
        };
      }
      mcpClient = options.client.withToken(caller);
    } catch (error) {
      return {
        ok: false,
        response: responder.fail(() => classifyAuthentication(error), error, presented),
      };
    }

    const authInfo: AuthInfo = {
      token: "",
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
    const context: RequestContext = { principal, mcpClient };
    return {
      ok: true,
      authInfo,
      caller: context,
      scheme: presented,
      run: async <T>(fn: () => T | Promise<T>): Promise<T> =>
        runWithRequestContext(context, fn),
    };
  }

  return { authenticate, resource, resourceUrl, metadataUrl, schemes, responder };
}

/**
 * Authenticates one MCP HTTP request: extracts a Bearer or DPoP credential, verifies it,
 * enforces `requiredScopes` and creates the request-scoped client. It does not serve the
 * metadata document or call any handler; {@link createMcpHandler} is built on it, and you
 * can build your own transport on it the same way.
 *
 * Accepted schemes and challenges follow `client.dpopMode`. Failures become RFC 6750
 * responses with a generic body and a rebuilt `WWW-Authenticate` challenge; verifier messages
 * are never echoed. The returned promise rejects only for invalid configuration, never for a bad request.
 *
 * DPoP `htu` is checked against `request.url`, so pass a `Request` whose URL is the public one
 * the client used.
 *
 * @param request - The incoming request.
 * @param options - The client and the server-wide settings.
 * @returns `{ ok: true, authInfo, caller, run }` for an authenticated request, otherwise
 * `{ ok: false, response }` with the response to return.
 * @throws {InvalidConfigurationError} When `resource` cannot be derived or differs from the
 * client audience, or `realm` is not usable in a challenge.
 * @throws {TypeError} When an explicit `resource` is not an absolute URL.
 */
export async function authenticateRequest(
  request: Request,
  options: AuthenticateRequestOptions,
): Promise<AuthenticateResult> {
  return createAuthenticator(options).authenticate(request);
}

/** The path part of a resource URL as used in the RFC 9728 well-known path: empty for the root. */
export function resourcePathOf(resourceUrl: URL): string {
  return resourceUrl.pathname === "/" ? "" : resourceUrl.pathname.replace(/\/$/, "");
}
