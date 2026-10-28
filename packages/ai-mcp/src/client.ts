import { ApiClient, InvalidConfigurationError } from '@auth0/auth0-api-js';
import type {
  IndexedTokenStore,
  OnBehalfOfTokenResult,
  TokenStore,
  VerifiedToken,
  VerifyAccessTokenOptions,
} from '@auth0/auth0-api-js';
import { UnauthenticatedError } from './errors.js';
import { buildPrincipal } from './principal.js';
import { createRequestScopedClient } from './request-scoped-client.js';
import { SingleFlight } from './single-flight.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, assertValidTimeout, createTimeoutFetch } from './timeout-fetch.js';
import type { McpClientOptions, Principal, RequestScopedMcpClient } from './types.js';

/**
 * An opaque handle for a caller whose access token has been verified by an
 * {@link McpClient}.
 *
 * It exposes only the caller's {@link Principal}. The verified token is held
 * privately by the client that issued the handle, and the handle serializes and
 * inspects to a redacted view, so logging it cannot leak a credential. Only
 * {@link McpClient.verifyAccessToken} produces handles that
 * {@link McpClient.withToken} accepts. A copy, a hand-built object or a handle from
 * another client is rejected.
 */
export interface VerifiedCaller {
  /** The caller's identity. */
  readonly principal: Principal;
}

/**
 * Thrown by {@link McpClient.withToken} when the value passed in was not produced by this
 * client's {@link McpClient.verifyAccessToken}.
 *
 * This is a server programming error (a wrong, copied or hand-built handle), not a problem
 * with the caller's credentials. It deliberately does not extend the core `AuthError`, so a
 * transport maps it to an internal server error and never to a 401 challenge. Its message
 * is fixed and generic.
 */
export class ForeignCallerError extends Error {
  constructor() {
    super('Caller handle was not issued by this client.');
    this.name = 'ForeignCallerError';
  }
}

/** Verifies incoming access tokens and creates clients bound to the verified caller. */
export interface McpClient {
  /**
   * The tenant domain this client was created with, exactly as given to
   * {@link createMcpClient}, or `undefined` when none was declared. Ingress code
   * reads it to derive the issuer it advertises. With a supplied `apiClient` it is
   * the value declared next to it; it cannot be checked against that client.
   */
  readonly domain?: string;
  /**
   * The API identifier this client requires as `aud`, exactly as given to
   * {@link createMcpClient}, or `undefined` when none was declared. Ingress code
   * reads it to default the resource it advertises.
   */
  readonly audience?: string;
  /**
   * The DPoP mode this client enforces: the `dpop.mode` it was created with, or
   * `'allowed'` when none was given. Ingress code reads it to decide which schemes
   * to accept and advertise. When you pass your own `apiClient` its mode cannot be
   * read, so this reports `'allowed'`; build the client from options if challenges
   * must reflect `'required'` or `'disabled'`.
   */
  readonly dpopMode: 'allowed' | 'required' | 'disabled';
  /**
   * Verifies an access token (Bearer or DPoP) and resolves the caller. Organization
   * policy and DPoP rules configured on the client are enforced here. Errors from the
   * core client propagate unchanged.
   *
   * A DPoP-bound subject token can be exchanged on behalf of the caller only because
   * it is verified here, at ingress, and the verified claims are passed to the core
   * client. The exchange request itself carries no DPoP proof. If the authorization
   * server rejects that exchange, the error propagates to the caller.
   *
   * With `dpop.mode` set to `'disabled'` the core client accepts a DPoP-bound token
   * presented as a Bearer token. Leave DPoP enabled unless you intend that.
   */
  verifyAccessToken(options: VerifyAccessTokenOptions): Promise<VerifiedCaller>;
  /**
   * Creates a client bound to a caller returned by this client's
   * {@link McpClient.verifyAccessToken}.
   * @throws {ForeignCallerError} When `caller` was not produced by this client. This is a
   * programming error and is not an authentication failure.
   * @throws {UnauthenticatedError} When the caller's token has expired.
   */
  withToken(caller: VerifiedCaller): RequestScopedMcpClient;
}

function isIndexedStore(store: TokenStore | undefined): store is IndexedTokenStore {
  const candidate = store as Partial<IndexedTokenStore> | undefined;
  return typeof candidate?.addIndexMember === 'function' && typeof candidate.listIndexMembers === 'function';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

const CORE_CLIENT_OPTIONS = [
  'clientId',
  'clientSecret',
  'scopeMatching',
  'organizationPolicy',
  'organizationId',
  'dpop',
  'requestTimeoutMs',
] as const;

/**
 * Creates an {@link McpClient}.
 *
 * When `scopeMatching` is `'non_strict'` and no indexed `tokenStore` is supplied, this
 * throws at construction. If you pass your own `apiClient`, its matching mode cannot be
 * read, so that check is skipped and the core client reports a mismatch on the first
 * token request instead. Supplying `apiClient` together with any option that configures
 * the core client is rejected, so no setting is silently ignored.
 *
 * @throws {InvalidConfigurationError} On an unusable scope matching and store combination,
 * on an invalid `requestTimeoutMs`, on `apiClient` combined with core client options, or on any invalid option the core
 * client rejects.
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  if (options.apiClient !== undefined) {
    const conflicting = CORE_CLIENT_OPTIONS.filter((name) => options[name] !== undefined);
    if (conflicting.length > 0) {
      throw new InvalidConfigurationError(
        `Invalid configuration: "apiClient" cannot be combined with ${conflicting.map((n) => `"${n}"`).join(', ')}. Configure those on the client you pass in.`
      );
    }
  } else if (options.scopeMatching === 'non_strict' && !isIndexedStore(options.tokenStore)) {
    throw new InvalidConfigurationError(
      'Invalid scope matching configuration: "non_strict" requires an indexed token store.'
    );
  }

  let timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  if (options.apiClient === undefined && options.requestTimeoutMs !== undefined) {
    try {
      timeoutMs = assertValidTimeout(options.requestTimeoutMs);
    } catch (error) {
      throw new InvalidConfigurationError(
        `Invalid configuration: "requestTimeoutMs" ${(error as RangeError).message}.`
      );
    }
  }

  const apiClient =
    options.apiClient ??
    new ApiClient({
      domain: options.domain,
      audience: options.audience,
      ...(options.clientId !== undefined && { clientId: options.clientId }),
      ...(options.clientSecret !== undefined && { clientSecret: options.clientSecret }),
      ...(options.scopeMatching !== undefined && { scopeMatching: options.scopeMatching }),
      ...(options.organizationPolicy !== undefined && { organizationPolicy: options.organizationPolicy }),
      ...(options.organizationId !== undefined && { organizationId: options.organizationId }),
      ...(options.dpop !== undefined && { dpop: options.dpop }),
      customFetch: createTimeoutFetch(timeoutMs),
    });

  const tokenStore = options.tokenStore;
  // One per client: request-scoped clients of this client share concurrent exchanges.
  const exchanges = new SingleFlight<OnBehalfOfTokenResult>();
  const exchangeIdentity = {
    tenant: options.domain,
    clientId: options.clientId,
    audience: options.audience,
    layout: options.scopeMatching === 'non_strict' ? ('index' as const) : ('strict' as const),
  };
  // Maps each handle this client issued to the token the core client verified. Without a
  // store the core client only compares token strings and never re-verifies, so a handle
  // this client did not issue must never reach it. The core claims object is stored as
  // returned, because the core client recognizes verified claims by object identity.
  const issued = new WeakMap<VerifiedCaller, VerifiedToken>();

  return {
    domain: nonEmptyString(options.domain),
    audience: nonEmptyString(options.audience),
    dpopMode: options.apiClient === undefined ? (options.dpop?.mode ?? 'allowed') : 'allowed',

    async verifyAccessToken(verifyOptions) {
      const claims = await apiClient.verifyAccessToken(verifyOptions);
      const principal = buildPrincipal(claims);
      const redacted = () => ({ principal });
      const caller: VerifiedCaller = Object.freeze({
        principal,
        toJSON: redacted,
        [Symbol.for('nodejs.util.inspect.custom')]: () => ({ principal }),
      });
      issued.set(caller, Object.freeze({ accessToken: verifyOptions.accessToken, claims }));
      return caller;
    },

    withToken(caller) {
      const verified = typeof caller === 'object' && caller !== null ? issued.get(caller) : undefined;
      if (verified === undefined) {
        throw new ForeignCallerError();
      }
      if (caller.principal.expiresAt <= Math.floor(Date.now() / 1000)) {
        throw new UnauthenticatedError('Access token has expired.');
      }
      return createRequestScopedClient({
        apiClient,
        tokenStore,
        principal: caller.principal,
        verified,
        exchanges,
        exchangeIdentity,
      });
    },
  };
}
