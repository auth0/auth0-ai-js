import type { VerifiedAccessTokenClaims } from '@auth0/auth0-api-js';
import { UnauthenticatedError } from './errors.js';
import type { Principal } from './types.js';

/** Reads a claim only when it is an own property, so prototype values never count. */
function ownClaim(claims: object, name: string): unknown {
  return Object.hasOwn(claims, name) ? (claims as Record<string, unknown>)[name] : undefined;
}

/** Returns the value when it is a non-empty string, otherwise `null`. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Builds a {@link Principal} from the claims of an already verified access token.
 *
 * This function does not verify anything. Pass only claims returned by token
 * verification. Every claim is read as an own property of `claims`; values
 * inherited through the prototype chain are ignored.
 *
 * - `sub` must be a non-blank string.
 * - `expiresAt` comes from `exp`, which must be a finite number of epoch seconds.
 * - `clientId` is the `client_id` claim when it is a non-empty string, otherwise
 *   the `azp` claim when that is a non-empty string, otherwise `null`.
 * - `orgId` is the `org_id` claim when it is a non-empty string, otherwise `null`.
 * - `scopes` come from the space-delimited `scope` claim only. Empty entries are
 *   dropped, and a missing or non-string claim gives an empty list.
 * - `permissions` come from the `permissions` claim. `null` means the claim is
 *   absent, so permissions are unknown. When the claim is present but is not an
 *   array the result is an empty list (no permissions), and non-string entries
 *   are dropped, so malformed data never widens access.
 *
 * The returned principal and its arrays are frozen.
 *
 * @param claims - Verified access token claims.
 * @returns The resolved principal.
 * @throws {UnauthenticatedError} When `sub` is missing, blank or not a string, or
 * `exp` is missing or not a finite number. The message never contains claim values.
 * The error carries no `WWW-Authenticate` challenge, so the HTTP layer must add it.
 */
export function buildPrincipal(claims: VerifiedAccessTokenClaims): Principal {
  const sub = ownClaim(claims, 'sub');
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new UnauthenticatedError('Access token has a missing or blank subject.');
  }

  const exp = ownClaim(claims, 'exp');
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new UnauthenticatedError('Access token has a missing or invalid expiry.');
  }

  const rawScope = ownClaim(claims, 'scope');
  const scopes = typeof rawScope === 'string' ? rawScope.split(/\s+/).filter(Boolean) : [];

  const rawPermissions = ownClaim(claims, 'permissions');
  let permissions: string[] | null = null;
  if (rawPermissions !== undefined) {
    permissions = Array.isArray(rawPermissions)
      ? rawPermissions.filter((p): p is string => typeof p === 'string')
      : [];
    Object.freeze(permissions);
  }

  return Object.freeze({
    sub,
    expiresAt: exp,
    scopes: Object.freeze(scopes) as string[],
    permissions,
    clientId: nonEmptyString(ownClaim(claims, 'client_id')) ?? nonEmptyString(ownClaim(claims, 'azp')),
    orgId: nonEmptyString(ownClaim(claims, 'org_id')),
  });
}
