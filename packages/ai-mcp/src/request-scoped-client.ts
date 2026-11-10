import * as core from '@auth0/auth0-api-js';
import { ApiClient, AuthError, buildOboTokenKey, normalizeScopes, VerifyAccessTokenError } from '@auth0/auth0-api-js';
import type { OboCacheKeyLayout, OnBehalfOfTokenResult, TokenStore, VerifiedToken } from '@auth0/auth0-api-js';
import { warn } from './diagnostics.js';
import { DownscopedTokenError, InsufficientScopeError, UnauthenticatedError } from './errors.js';
import type { SingleFlight } from './single-flight.js';
import { EXPIRY_BUFFER_SECONDS, KEYED_CLAIMS } from './token-cache.js';
import type { TokenCache } from './token-cache.js';
import type {
  ClientCredentialsOptions,
  ClientCredentialsTokenResult,
  ConnectionTokenResult,
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
  /**
   * Caches client credentials and Token Vault tokens in `tokenStore`, shared by every
   * request-scoped client of the same parent. `undefined` when there is no store, or when the
   * parent client does not know its own client id (a supplied `apiClient`): those two token
   * operations then go to the tenant on every call.
   */
  readonly tokenCache?: TokenCache | undefined;
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

/** Which token operation produced a result, for diagnostics only. */
type TokenOperation = 'on_behalf_of' | 'client_credentials' | 'connection';

/**
 * Rejects a token the authorization server issued that is expired or about to expire (within
 * {@link EXPIRY_BUFFER_SECONDS}), or that came back without a usable expiry, so it is never
 * returned to tool code. The failure carries the generic message and a diagnostic `cause` that
 * holds no token data and says which of the two happened. The same line is written with
 * `console.warn` (operation name only), because the generic error alone does not tell an
 * operator why a call failed. `expiresAt` is epoch seconds, the convention of the core client.
 * The core client computes it from `expires_in`, so a response without that field arrives here
 * as `NaN`.
 * The core client stores an On Behalf Of result before this check runs and its cache treats an
 * expired entry as a miss, so an expired entry may remain in a store but is never served. The
 * client credentials and connection caches of this package are the other way round: they write
 * only after this check passed.
 */
function assertNotExpired(expiresAt: number, operation: TokenOperation): void {
  if (!Number.isFinite(expiresAt)) {
    const reason = 'The token endpoint issued a token without a usable expiry (expires_in is missing or invalid).';
    warn(`${reason} Operation: ${operation}.`);
    throw withCause(new Error(GENERIC_FAILURE_MESSAGE), new Error(reason));
  }
  if (expiresAt <= Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SECONDS) {
    const reason = `The token endpoint issued a token that is already expired or expires within ${EXPIRY_BUFFER_SECONDS} seconds.`;
    warn(`${reason} Operation: ${operation}.`);
    throw withCause(new Error(GENERIC_FAILURE_MESSAGE), new Error(reason));
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

/** True for a fetch `Headers` object, including one created by another implementation of the class. */
function isHeaders(value: object): value is Headers {
  return (
    value instanceof Headers ||
    (typeof (value as Headers).get === 'function' && typeof (value as Headers).forEach === 'function')
  );
}

/**
 * Copies response headers so no sanitized error shares an object with the original or with
 * another copy. A fetch `Headers` object (token endpoint errors) is cloned; a plain record
 * (`AuthError`) is copied one level deep. Anything else is dropped.
 */
function copyHeaders(headers: unknown): Headers | Record<string, string | string[]> | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  // Rebuilt from its entries rather than passed to the `Headers` constructor, which does not
  // read a `Headers` object created by another implementation of the class.
  if (isHeaders(headers)) {
    const copy = new Headers();
    headers.forEach((value, name) => copy.append(name, value));
    return copy;
  }
  const copy: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') copy[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) copy[name] = [...value];
  }
  return copy;
}

/**
 * Carries the HTTP details of a failed token request over to a sanitized error: `code`,
 * `statusCode` and `headers` (so a tool can read `Retry-After` from a rate limit response),
 * each only when the original has a value of the expected type. The response body is never
 * copied, because it can hold upstream detail the generic message exists to hide.
 */
function copyHttpDetails(from: unknown, to: Error & { code?: string; statusCode?: number; headers?: unknown }): void {
  if (!(from instanceof Error)) return;
  const { code, statusCode, headers } = from as { code?: unknown; statusCode?: unknown; headers?: unknown };
  if (typeof code === 'string') to.code = code;
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) to.statusCode = statusCode;
  const copied = copyHeaders(headers);
  if (copied !== undefined) to.headers = copied;
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
 * share one. A core error becomes a fresh instance of the same core class, so `instanceof`
 * checks keep working. The `code`, `statusCode` and `headers` (a copy) of the original are
 * kept whenever it has them, whichever class it is, so a tool can read `Retry-After` from a
 * rate limited token request. The response body is not kept.
 *
 * The one exception is a core `VerifyAccessTokenError`, which becomes an
 * {@link UnauthenticatedError}. Core raises it only when a token store is configured and the
 * caller's token has expired or is within five seconds of expiring. An error whose class is
 * not exported by the core package, and any non-core error (network failures, for example),
 * becomes a plain `AuthError` or `Error`, so no foreign prototype runs on the copy. Each call
 * returns a new instance.
 */
export function sanitizeTokenError(error: unknown): Error {
  if (
    error instanceof DownscopedTokenError ||
    error instanceof InsufficientScopeError ||
    error instanceof UnauthenticatedError
  ) {
    return error;
  }
  // With a token store configured, core 1.7.0 re-checks the caller's verified claims before it
  // reads the cache and refuses a token that is expired or within five seconds of expiry.
  // Those claims come from this server's own ingress check, so the only way to fail here is a
  // caller token that ran out while the request was being handled. That is the caller's
  // credential, not a server fault, so it surfaces as the package's 401 rather than as an
  // internal error. Without a store there is no such check: the exchange goes to the tenant,
  // which rejects an expired token, and that arrives as a token endpoint error instead.
  if (error instanceof VerifyAccessTokenError) {
    return withCause(new UnauthenticatedError(), error);
  }
  const known = error instanceof Error ? coreErrorPrototype(error) : undefined;
  let safe: Error;
  if (error instanceof AuthError) {
    safe = new AuthError(
      GENERIC_FAILURE_MESSAGE,
      error.code,
      error.statusCode,
      copyHeaders(error.headers) as Record<string, string | string[]> | undefined
    );
  } else {
    safe = new Error(GENERIC_FAILURE_MESSAGE);
    copyHttpDetails(error, safe);
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
  const { apiClient, tokenStore, principal, verified, exchanges, exchangeIdentity, tokenCache } = init;

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

  /** Requests a client credentials token from the tenant and rejects one that is unusable. */
  const issueClientCredentials = async (options: ClientCredentialsOptions): Promise<ClientCredentialsTokenResult> => {
    const issued = await apiClient.getClientCredentialsToken({
      audience: options.audience,
      ...(options.scope !== undefined && { scope: options.scope }),
    });
    assertNotExpired(issued.expiresAt, 'client_credentials');
    // RFC 6749 section 5.1: an absent `scope` means the grant equals the request, while an
    // empty string means nothing was granted. `??` keeps those two apart; `||` would not.
    return { ...issued, grantedScopes: normalizeScopes(issued.scope ?? options.scope ?? '') };
  };

  /**
   * Serves a client credentials token from the store when it holds a fresh one that covers the
   * request, and otherwise requests one. The credentials belong to this server, so the entry is
   * shared by every caller; the key holds no caller identity.
   *
   * A token is written only after it passed the expiry check and only when its grant covers the
   * request, so a narrowed grant (which the caller is refused) is never stored for a later call
   * to receive. An entry that does not cover the request, which only a store that was written
   * to by something else can hold, is a miss.
   */
  const cachedClientCredentials = async (
    cache: TokenCache,
    options: ClientCredentialsOptions
  ): Promise<ClientCredentialsTokenResult> => {
    const key = await cache.clientCredentialsKey(options.audience, options.scope);
    if (key === undefined) return issueClientCredentials(options);

    const hit = await cache.read(key);
    if (hit !== undefined && covers(options.scope, hit.grantedScopes)) {
      return {
        accessToken: hit.accessToken,
        expiresAt: hit.expiresAt,
        ...(hit.scope !== undefined && { scope: hit.scope }),
        ...(hit.tokenType !== undefined && { tokenType: hit.tokenType }),
        grantedScopes: hit.grantedScopes,
      };
    }

    // Concurrent identical requests share one grant. The outcome is not remembered once it
    // settles, so a failure is retried by the next call.
    const shared = await cache.clientCredentialsFlights.run(key, async () => {
      const issued = await issueClientCredentials(options);
      if (covers(options.scope, issued.grantedScopes)) await cache.write(key, issued);
      return issued;
    });
    // Each caller gets its own copy.
    return { ...shared, grantedScopes: [...shared.grantedScopes] };
  };

  /** Requests a connection token from the tenant and rejects one that is unusable. */
  const issueConnectionToken = async (options: TokenForConnectionOptions): Promise<ConnectionTokenResult> => {
    const issued = await apiClient.getAccessTokenForConnection({
      connection: options.connection,
      accessToken: verified.accessToken,
      ...(options.loginHint !== undefined && {
        loginHint: options.loginHint,
      }),
    });
    assertNotExpired(issued.expiresAt, 'connection');
    return issued;
  };

  /**
   * Rejects a caller whose own token is expired or within {@link EXPIRY_BUFFER_SECONDS} of
   * expiry. A stored connection token is served without asking the tenant, so this is the
   * only check that the caller still holds a valid token. It also covers a caller that joins
   * another caller's request of the same session. Both the principal's expiry and the `exp`
   * claim count, whichever is earlier.
   */
  const assertCallerNotExpired = (): void => {
    const exp = (verified.claims as Record<string, unknown>)['exp'];
    const expiries = [principal.expiresAt, ...(typeof exp === 'number' ? [exp] : [])];
    const earliest = Math.min(...expiries);
    if (!Number.isFinite(earliest) || earliest <= Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SECONDS) {
      throw new UnauthenticatedError('Access token has expired.');
    }
  };

  /**
   * Serves a Token Vault token from the store when it holds a fresh one for this caller,
   * connection and login hint, and otherwise requests one. The stored token belongs to the
   * user's account at the provider, so the key holds the caller's identity as the On Behalf Of
   * key does, and `connection` and `loginHint` of the result always come from the request.
   *
   * A caller whose claims cannot be keyed safely is never cached and never shares a request.
   */
  const cachedConnectionToken = async (
    cache: TokenCache,
    options: TokenForConnectionOptions
  ): Promise<ConnectionTokenResult> => {
    const key = await cache.connectionKey(verified, options.connection, options.loginHint);
    if (key === undefined) return issueConnectionToken(options);
    assertCallerNotExpired();

    const fromRequest = (token: {
      accessToken: string;
      expiresAt: number;
      scope?: string | undefined;
    }): ConnectionTokenResult => ({
      accessToken: token.accessToken,
      scope: token.scope,
      expiresAt: token.expiresAt,
      connection: options.connection,
      ...(options.loginHint !== undefined && { loginHint: options.loginHint }),
    });

    const hit = await cache.read(key);
    if (hit !== undefined) return fromRequest(hit);

    const shared = await cache.connectionFlights.run(key, async () => {
      const issued = await issueConnectionToken(options);
      await cache.write(key, {
        accessToken: issued.accessToken,
        expiresAt: issued.expiresAt,
        ...(issued.scope !== undefined && { scope: issued.scope }),
        grantedScopes: normalizeScopes(issued.scope ?? ''),
      });
      return issued;
    });
    return fromRequest(shared);
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
        assertNotExpired(result.expiresAt, 'on_behalf_of');

        // The core client caches the token under the scopes it was granted and does not
        // reject a narrowed result. Rejecting it here keeps the cache correct (a later,
        // narrower request can still reuse it) while this caller never runs with less
        // authority than it asked for. This runs per caller, after the shared exchange.
        assertCovers(options.scope, result.grantedScopes);
        return result;
      }),

    getClientCredentialsToken: async (options: ClientCredentialsOptions): Promise<ClientCredentialsTokenResult> => {
      const result = await guarded(() =>
        tokenCache === undefined ? issueClientCredentials(options) : cachedClientCredentials(tokenCache, options)
      );
      // Thrown outside `guarded`: this error is already sanitized and must keep its own cause.
      assertServerGrantCovers(options.scope, result.grantedScopes);
      return result;
    },

    getTokenForConnection: (options: TokenForConnectionOptions) =>
      guarded(() =>
        tokenCache === undefined ? issueConnectionToken(options) : cachedConnectionToken(tokenCache, options)
      ),

    getPrincipal(): Principal {
      return principal;
    },
  });
}
