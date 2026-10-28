import * as core from '@auth0/auth0-api-js';
import { ApiClient, AuthError, buildOboTokenKey, normalizeScopes, VerifyAccessTokenError } from '@auth0/auth0-api-js';
import type { OboCacheKeyLayout, OnBehalfOfTokenResult, TokenStore, VerifiedToken } from '@auth0/auth0-api-js';
import { DownscopedTokenError, InsufficientScopeError, UnauthenticatedError } from './errors.js';
import type { SingleFlight } from './single-flight.js';
import type {
  ClientCredentialsOptions,
  ClientCredentialsTokenResult,
  OnBehalfOfOptions,
  Principal,
  RequestScopedMcpClient,
  TokenForConnectionOptions,
} from './types.js';

/** Everything a request-scoped client needs from its parent client. */
export interface RequestScopedClientInit {
  /** The core client that performs the token operations. */
  readonly apiClient: ApiClient;
  /** Cache for exchanged tokens, or `undefined` to exchange on every call. */
  readonly tokenStore: TokenStore | undefined;
  /** The caller's identity. */
  readonly principal: Principal;
  /** The caller's verified token, exactly as produced by token verification. */
  readonly verified: VerifiedToken;
  /**
   * Shared by every request-scoped client created by the same parent client, so that
   * concurrent identical exchanges collapse into one.
   */
  readonly exchanges: SingleFlight<OnBehalfOfTokenResult>;
  /**
   * What the parent client fixes for every exchange it performs. These never differ
   * between request-scoped clients of one parent, and are part of the de-duplication key
   * so the key stays a superset of what the core cache distinguishes.
   */
  readonly exchangeIdentity: ExchangeIdentity;
}

/** The parent client's side of an exchange: who performs it and how scopes are matched. */
export interface ExchangeIdentity {
  /** The tenant domain the exchange is sent to. */
  readonly tenant: string;
  /** The client id performing the exchange, if configured. */
  readonly clientId: string | undefined;
  /** The audience the parent client validates incoming tokens against. */
  readonly audience: string;
  /** The scope matching layout the core client caches under. */
  readonly layout: OboCacheKeyLayout;
}

const KEYED_CLAIMS = ['iss', 'client_id', 'azp', 'sub', 'org_id', 'sid', 'jti'] as const;

/**
 * Builds the key that decides which concurrent exchanges may share one result, or
 * `undefined` when the caller's claims cannot be keyed safely and the exchange must not
 * be shared.
 *
 * The key is derived by the core client's own cache key builder from the same inputs the
 * core cache uses: exchanging tenant, client and audience, the subject token's issuer,
 * client, subject, organization and session (`sid`, else `jti`, else a digest of the
 * token), the requested audience and the normalized scope set. Two requests that core
 * would cache separately therefore never share a flight.
 */
async function flightKey(
  identity: ExchangeIdentity,
  verified: VerifiedToken,
  audience: string,
  scope: string | undefined
): Promise<string | undefined> {
  const claims = verified.claims as Record<string, unknown>;
  // The key encoding reads a non-string claim as absent, so such a token could collide with
  // a different identity. Exchange it alone.
  if (KEYED_CLAIMS.some((name) => claims[name] !== undefined && typeof claims[name] !== 'string')) {
    return undefined;
  }
  return buildOboTokenKey({
    layout: identity.layout,
    exchangeTenant: identity.tenant,
    exchangeClientId: identity.clientId,
    exchangeAudience: identity.audience,
    verified,
    requestedAudience: audience,
    scope,
  });
}

/**
 * Throws when scopes were requested and the grant does not include all of them.
 * No scope requested means nothing to enforce.
 */
function covers(requested: string | undefined, grantedScopes: readonly string[]): boolean {
  if (requested === undefined) return true;
  const granted = new Set(grantedScopes);
  return normalizeScopes(requested).every((scope) => granted.has(scope));
}

/** Rejects an exchanged token whose grant is narrower than requested, as a caller-facing error. */
function assertCovers(requested: string | undefined, grantedScopes: readonly string[]): void {
  if (!covers(requested, grantedScopes)) throw new DownscopedTokenError();
}

/**
 * Rejects a client credentials grant narrower than requested. The credentials belong to this
 * server, so the caller's token has no part in it and the caller cannot fix it. The failure
 * is therefore a plain server-side error rather than an auth error, and carries the
 * {@link DownscopedTokenError} as its `cause` for diagnostics.
 */
function assertServerGrantCovers(requested: string | undefined, grantedScopes: readonly string[]): void {
  if (!covers(requested, grantedScopes)) {
    throw withCause(new Error(GENERIC_FAILURE_MESSAGE), new DownscopedTokenError());
  }
}

/** The only message an error leaving a request-scoped client may carry besides the package's own errors. */
const GENERIC_FAILURE_MESSAGE = 'The token operation failed.';

function withCause<T extends Error>(error: T, cause: unknown): T {
  Object.defineProperty(error, 'cause', {
    value: cause,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return error;
}

/**
 * Rejects a token the authorization server issued that is already expired, so it is never
 * returned to tool code. The failure carries the generic message and a diagnostic `cause`
 * that holds no token data. `expiresAt` is epoch seconds, the convention of the core client.
 * The core client stores an exchange result before this check runs and its cache treats an
 * expired entry as a miss, so an expired entry may remain in a store but is never served.
 */
function assertNotExpired(expiresAt: number): void {
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw withCause(new Error(GENERIC_FAILURE_MESSAGE), new Error('The token endpoint issued an already expired token.'));
  }
}

/** Prototypes of the error classes the core package exports. Only these are ever copied onto a sanitized error. */
const CORE_ERROR_PROTOTYPES: ReadonlySet<object> = new Set(
  (Object.values(core) as unknown[]).flatMap((value) =>
    typeof value === 'function' && (value as { prototype?: unknown }).prototype instanceof Error
      ? [(value as { prototype: object }).prototype]
      : []
  )
);

/** The nearest core error prototype in the error's chain, or `undefined` for any other error. */
function coreErrorPrototype(error: Error): object | undefined {
  for (let proto = Object.getPrototypeOf(error); proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (CORE_ERROR_PROTOTYPES.has(proto)) return proto;
  }
  return undefined;
}

/** Copies headers one level deep, so no sanitized error shares an object with the original or another copy. */
function copyHeaders(headers: Record<string, string | string[]> | undefined) {
  if (headers === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? [...value] : value])
  );
}

/**
 * Returns an error that is safe to show to an MCP client: it carries a fixed message and
 * keeps the original as `cause`.
 *
 * `cause` is for server-side diagnostics only. It holds the original error, whose message may
 * contain upstream detail, so never serialize it into a response.
 *
 * The package's own errors already have generic messages and pass through unchanged. They are
 * thrown per caller (after the shared exchange settles), never from inside it, so waiters never
 * share one. A core error becomes a fresh instance of the same core class with the same `code`,
 * `statusCode` and a copy of the `headers`, so `instanceof` checks and status mapping keep
 * working. The one exception is a core `VerifyAccessTokenError` (the caller's token expired
 * before the exchange), which becomes an {@link UnauthenticatedError}. An error whose class is
 * not exported by the core package, and any non-core error (network failures, for example),
 * becomes a plain `AuthError` or `Error`, so no foreign
 * prototype runs on the copy. Each call returns a new instance.
 */
export function sanitizeTokenError(error: unknown): Error {
  if (
    error instanceof DownscopedTokenError ||
    error instanceof InsufficientScopeError ||
    error instanceof UnauthenticatedError
  ) {
    return error;
  }
  // Core 1.7.0 re-checks the caller's verified claims before it exchanges. Those claims come
  // from this server's own ingress check, so the only way to fail here is a caller token that
  // expired while the request was running. That is the caller's credential, not a server
  // fault, so it surfaces as the package's 401 rather than as an internal error.
  if (error instanceof VerifyAccessTokenError) {
    return withCause(new UnauthenticatedError(), error);
  }
  const known = error instanceof Error ? coreErrorPrototype(error) : undefined;
  let safe: Error;
  if (error instanceof AuthError) {
    safe = new AuthError(GENERIC_FAILURE_MESSAGE, error.code, error.statusCode, copyHeaders(error.headers));
  } else {
    safe = new Error(GENERIC_FAILURE_MESSAGE);
  }
  if (known !== undefined) {
    Object.setPrototypeOf(safe, known);
    safe.name = (known as { constructor: { name: string } }).constructor.name;
  }
  return withCause(safe, error);
}

/**
 * Creates a {@link RequestScopedMcpClient} bound to one verified caller.
 *
 * The access token and verified claims are held in closure variables only. The
 * returned object has no data properties, so serializing or logging it cannot
 * reveal the token.
 *
 * The caller's `verified` object must be the one the core client produced for
 * this exact token. It is passed to the core client untouched, because the core
 * client recognizes verified claims by object identity.
 *
 * @param init - The core client, optional token store and the verified caller.
 * @returns A frozen client that always acts for the given caller.
 */
export function createRequestScopedClient(init: RequestScopedClientInit): RequestScopedMcpClient {
  const { apiClient, tokenStore, principal, verified, exchanges, exchangeIdentity } = init;

  const exchange = (options: OnBehalfOfOptions) =>
    apiClient.getTokenOnBehalfOf(
      verified.accessToken,
      {
        audience: options.audience,
        ...(options.scope !== undefined && { scope: options.scope }),
      },
      { ...(tokenStore !== undefined && { store: tokenStore }), verified }
    );

  /** Runs an operation and rethrows any failure as a sanitized error. */
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw sanitizeTokenError(error);
    }
  };

  return Object.freeze({
    getTokenOnBehalfOf: (options: OnBehalfOfOptions) =>
      guarded(async () => {
        // Concurrent identical requests from this parent client share one exchange. The
        // outcome is not remembered once it settles, so a failure is retried by the next call.
        const key = await flightKey(exchangeIdentity, verified, options.audience, options.scope);
        const shared = key === undefined ? await exchange(options) : await exchanges.run(key, () => exchange(options));
        // Each caller gets its own copy, so one caller changing its result cannot alter another's.
        const result = { ...shared, grantedScopes: [...shared.grantedScopes] };
        assertNotExpired(result.expiresAt);

        // The core client caches the token under the scopes it was granted and does not
        // reject a narrowed result. Rejecting it here keeps the cache correct (a later,
        // narrower request can still reuse it) while this caller never runs with less
        // authority than it asked for. This runs per caller, after the shared exchange.
        assertCovers(options.scope, result.grantedScopes);
        return result;
      }),

    getClientCredentialsToken: async (options: ClientCredentialsOptions): Promise<ClientCredentialsTokenResult> => {
      const result = await guarded(async () => {
        const issued = await apiClient.getClientCredentialsToken({
          audience: options.audience,
          ...(options.scope !== undefined && { scope: options.scope }),
        });
        assertNotExpired(issued.expiresAt);
        return issued;
      });
      // RFC 6749 section 5.1: an absent `scope` means the grant equals the request, while an
      // empty string means nothing was granted. `??` keeps those two apart; `||` would not.
      const grantedScopes = normalizeScopes(result.scope ?? options.scope ?? '');
      // Thrown outside `guarded`: this error is already sanitized and must keep its own cause.
      assertServerGrantCovers(options.scope, grantedScopes);
      return { ...result, grantedScopes };
    },

    getTokenForConnection: (options: TokenForConnectionOptions) =>
      guarded(async () => {
        const issued = await apiClient.getAccessTokenForConnection({
          connection: options.connection,
          accessToken: verified.accessToken,
          ...(options.loginHint !== undefined && {
            loginHint: options.loginHint,
          }),
        });
        assertNotExpired(issued.expiresAt);
        return issued;
      }),

    getPrincipal(): Principal {
      return principal;
    },
  });
}
