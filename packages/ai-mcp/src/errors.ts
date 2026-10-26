import { AuthError } from '@auth0/auth0-api-js';

type ErrorHeaders = Record<string, string | string[]>;

/**
 * Raised when a request reaches protected code without an authenticated caller,
 * for example when no request context is active or no principal was resolved.
 *
 * HTTP semantics: 401 Unauthorized. Its `code` is `invalid_token`, the RFC 6750
 * section 3.1 error value for a missing or unusable credential. Pass `headers`
 * through to the response so a `WWW-Authenticate` challenge, when one is
 * supplied, reaches the client.
 */
export class UnauthenticatedError extends AuthError {
  constructor(message = 'Unauthenticated', headers?: ErrorHeaders) {
    super(message, 'invalid_token', 401, headers);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Raised when the authenticated caller lacks one or more scopes that a tool or
 * route requires.
 *
 * HTTP semantics: 403 Forbidden with the RFC 6750 section 3.1 error value
 * `insufficient_scope`. The message is generic by design and never names the
 * missing scopes, so a client cannot enumerate what a server expects. Read
 * {@link InsufficientScopeError.requiredScopes} on the server side when the
 * list is needed for a challenge or for logging.
 */
export class InsufficientScopeError extends AuthError {
  /**
   * The scopes the caller needed. This is a frozen copy of the list passed to
   * the constructor, so changing the original array afterwards has no effect.
   */
  readonly requiredScopes: readonly string[];

  constructor(
    requiredScopes: readonly string[],
    message = 'Missing one or more required scopes.',
    headers?: ErrorHeaders
  ) {
    super(message, 'insufficient_scope', 403, headers);
    this.name = 'InsufficientScopeError';
    this.requiredScopes = Object.freeze([...requiredScopes]);
  }
}

/**
 * Raised when a token exchange succeeded but the issued token does not carry
 * every scope that was requested, so using it would run with less authority
 * than the caller asked for.
 *
 * HTTP semantics: 403 Forbidden with the RFC 6750 section 3.1 error value
 * `insufficient_scope`. The error carries no scope data, which keeps the
 * granted and requested scope sets out of responses and logs.
 */
export class DownscopedTokenError extends AuthError {
  constructor(message = 'Exchanged token did not include all requested scopes.', headers?: ErrorHeaders) {
    super(message, 'insufficient_scope', 403, headers);
    this.name = 'DownscopedTokenError';
  }
}
