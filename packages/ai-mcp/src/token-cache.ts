import { normalizeScopes } from '@auth0/auth0-api-js';
import type { CachedToken, TokenStore, VerifiedToken } from '@auth0/auth0-api-js';
import { base64url } from 'jose';
import { warn } from './diagnostics.js';
import { SingleFlight } from './single-flight.js';
import type { ClientCredentialsTokenResult, ConnectionTokenResult } from './types.js';

/*
 * Wrapper-side cache for client credentials tokens and Token Vault (connection) tokens.
 *
 * The core client caches only On Behalf Of tokens, under keys that start with `a0.obo.`. The
 * two other token operations are cached here, in the same store, under their own namespaces so
 * that an entry of one kind can never be read as another. This module is internal and is not
 * exported from the package.
 */

/**
 * Seconds before its expiry at which a token already counts as expired. It is the margin the
 * core client's cache uses when it decides whether a stored On Behalf Of token can be served,
 * and the margin the request-scoped client applies to every issued token, so a token this
 * package returns is never one the cache would refuse a moment later. It also covers the time
 * the tool needs to use the token before the downstream API checks it.
 */
export const EXPIRY_BUFFER_SECONDS = 5;

/** Key namespaces. Never `a0.obo.`, which belongs to the core client. */
const CLIENT_CREDENTIALS_PREFIX = 'a0.mcp.m2m.v1';
const CONNECTION_PREFIX = 'a0.mcp.tv.v1';

/**
 * The claims of the caller's token that go into a Token Vault key. The core client reads a
 * claim of any other type as absent, so such a token could collide with a different identity.
 * Callers with such a token are never cached or shared.
 */
export const KEYED_CLAIMS = ['iss', 'client_id', 'azp', 'sub', 'org_id', 'sid', 'jti'] as const;

const ABSENT_FIELD = '-';

/** `len:value`, or `-` for an absent value, so an absent field differs from an empty one and no two field lists encode alike. */
function encodeField(value: string | undefined): string {
  return value === undefined ? ABSENT_FIELD : `${value.length}:${value}`;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64url.encode(new Uint8Array(digest));
}

function claimString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyClaimString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claimString(claims, name);
  return value !== undefined && value !== '' ? value : undefined;
}

/** Same rule the core client uses for On Behalf Of: `sid`, else `jti`, else a digest of the token. */
async function deriveSessionKey(verified: VerifiedToken): Promise<string> {
  const claims = verified.claims as Record<string, unknown>;
  const sid = nonEmptyClaimString(claims, 'sid');
  if (sid !== undefined) return `sid:${sid}`;
  const jti = nonEmptyClaimString(claims, 'jti');
  if (jti !== undefined) return `jti:${jti}`;
  return `at:${await sha256Base64Url(verified.accessToken)}`;
}

/** True when a claim that goes into a key has a type the key cannot represent. */
export function hasUnkeyableClaims(verified: VerifiedToken): boolean {
  const claims = verified.claims as Record<string, unknown>;
  return KEYED_CLAIMS.some((name) => claims[name] !== undefined && typeof claims[name] !== 'string');
}

/** The tenant as an origin in lower case, so `Tenant.example.com` and `https://tenant.example.com` key alike. */
function tenantOrigin(domain: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`).origin.toLowerCase();
  } catch {
    return domain.toLowerCase();
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Reads an optional own property, or reports that it holds something other than a string. */
function optionalString(entry: object, name: string): { ok: true; value: string | undefined } | { ok: false } {
  if (!Object.hasOwn(entry, name)) return { ok: true, value: undefined };
  const value = (entry as Record<string, unknown>)[name];
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === 'string' ? { ok: true, value } : { ok: false };
}

/**
 * Returns a copy of a stored entry, or `undefined` when it is not a usable token. The shape is
 * checked against what this module writes, from own properties only, and every value is copied
 * so nothing the store keeps a reference to reaches the caller.
 */
function copyUsable(entry: unknown): CachedToken | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  if (
    !Object.hasOwn(entry, 'accessToken') ||
    !Object.hasOwn(entry, 'expiresAt') ||
    !Object.hasOwn(entry, 'grantedScopes')
  ) {
    return undefined;
  }
  const { accessToken, expiresAt, grantedScopes } = entry as Record<string, unknown>;
  if (!isNonEmptyString(accessToken)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined;
  if (!Array.isArray(grantedScopes) || !grantedScopes.every((item) => typeof item === 'string')) return undefined;
  const scope = optionalString(entry, 'scope');
  const tokenType = optionalString(entry, 'tokenType');
  if (!scope.ok || !tokenType.ok) return undefined;
  return {
    accessToken,
    expiresAt,
    ...(scope.value !== undefined && { scope: scope.value }),
    ...(tokenType.value !== undefined && { tokenType: tokenType.value }),
    grantedScopes: [...(grantedScopes as string[])],
  };
}

/** What one McpClient holds to cache the two token operations the core client does not cache. */
export interface TokenCache {
  /** Concurrent identical client credentials requests share one grant. */
  readonly clientCredentialsFlights: SingleFlight<ClientCredentialsTokenResult>;
  /** Concurrent identical Token Vault requests share one exchange. */
  readonly connectionFlights: SingleFlight<ConnectionTokenResult>;
  /**
   * The key for a client credentials token, or `undefined` when it must not be cached: the
   * audience is not a non-empty string, or a given scope is not a string or has no scope in
   * it. The core client rejects such a request, and the rejection is never cached.
   */
  clientCredentialsKey(audience: unknown, scope: unknown): Promise<string | undefined>;
  /**
   * The key for a Token Vault token, or `undefined` when the caller's claims cannot be keyed
   * safely or the request is not made of strings.
   */
  connectionKey(verified: VerifiedToken, connection: unknown, loginHint: unknown): Promise<string | undefined>;
  /**
   * A copy of the usable, unexpired entry under `key`, or `undefined`. A store that throws, an
   * entry of the wrong shape and an entry within {@link EXPIRY_BUFFER_SECONDS} of expiry all
   * read as a miss.
   */
  read(key: string): Promise<CachedToken | undefined>;
  /** Stores a copy of `token` under `key`. A store that throws is ignored. */
  write(key: string, token: CachedToken): Promise<void>;
}

/**
 * Creates the cache for one McpClient, or `undefined` when there is nothing to cache with.
 *
 * Returns `undefined` without a `tokenStore`, and without a `clientId`. The `clientId` is part
 * of every key, and it is unknown when the caller supplies a pre-built `apiClient`, so such a
 * client cannot be told apart from another one that shares the store. It then caches nothing
 * for these two operations and keeps them single-flight free, as before.
 */
export function createTokenCache(options: {
  store: TokenStore | undefined;
  tenant: string;
  clientId: string | undefined;
}): TokenCache | undefined {
  const { store, clientId } = options;
  if (store === undefined || !isNonEmptyString(clientId) || !isNonEmptyString(options.tenant)) return undefined;
  const tenant = tenantOrigin(options.tenant);

  /** Each kind of store failure is reported once per client, with fixed text. */
  const reported = new Set<'read' | 'write'>();
  const report = (kind: 'read' | 'write'): void => {
    if (reported.has(kind)) return;
    reported.add(kind);
    warn(
      kind === 'read'
        ? 'The token store failed on a read for a client credentials or connection token. The read is treated as a cache miss. Further failures like this are not logged again by this client.'
        : 'The token store failed on a write for a client credentials or connection token. The token is still returned and is not cached. Further failures like this are not logged again by this client.'
    );
  };

  return {
    clientCredentialsFlights: new SingleFlight<ClientCredentialsTokenResult>(),
    connectionFlights: new SingleFlight<ConnectionTokenResult>(),

    async clientCredentialsKey(audience, scope) {
      if (!isNonEmptyString(audience)) return undefined;
      let encodedScope: string | undefined;
      if (scope !== undefined) {
        if (typeof scope !== 'string') return undefined;
        const normalized = normalizeScopes(scope).join(' ');
        if (normalized === '') return undefined;
        encodedScope = normalized;
      }
      const fields = [tenant, clientId, audience, encodedScope].map(encodeField).join('');
      return `${CLIENT_CREDENTIALS_PREFIX}.${await sha256Base64Url(fields)}`;
    },

    async connectionKey(verified, connection, loginHint) {
      if (!isNonEmptyString(connection)) return undefined;
      if (loginHint !== undefined && typeof loginHint !== 'string') return undefined;
      if (hasUnkeyableClaims(verified)) return undefined;
      const claims = verified.claims as Record<string, unknown>;
      const fields = [
        tenant,
        clientId,
        claimString(claims, 'iss'),
        claimString(claims, 'client_id') ?? claimString(claims, 'azp'),
        claimString(claims, 'sub'),
        claimString(claims, 'org_id'),
        await deriveSessionKey(verified),
        connection,
        loginHint,
      ]
        .map(encodeField)
        .join('');
      return `${CONNECTION_PREFIX}.${await sha256Base64Url(fields)}`;
    },

    async read(key) {
      let entry: unknown;
      try {
        entry = await store.get(key);
      } catch {
        report('read');
        return undefined;
      }
      let usable: CachedToken | undefined;
      try {
        usable = copyUsable(entry);
      } catch {
        // An entry whose properties throw when read is not a token this module wrote.
        return undefined;
      }
      if (usable === undefined) return undefined;
      return usable.expiresAt > Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SECONDS ? usable : undefined;
    },

    async write(key, token) {
      try {
        await store.set(key, {
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
          ...(token.scope !== undefined && { scope: token.scope }),
          ...(token.tokenType !== undefined && { tokenType: token.tokenType }),
          grantedScopes: [...token.grantedScopes],
        });
      } catch {
        report('write');
      }
    },
  };
}
