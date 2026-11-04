import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import type { CachedToken, IndexedTokenStore, TokenIndexMember, TokenStore } from '@auth0/auth0-api-js';
import { CompactEncrypt, compactDecrypt } from 'jose';
import { warn } from '../diagnostics.js';

/** Shortest accepted secret, in characters. */
const MIN_SECRET_LENGTH = 32;

/** A256CBC-HS512 uses a 512-bit combined key. */
const KEY_BYTES = 64;

const HKDF_SALT = new TextEncoder().encode('auth0-ai-mcp.encrypted-token-store.salt.v1');
const HKDF_INFO = new TextEncoder().encode('auth0-ai-mcp.encrypted-token-store.content-key.v1');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Options for {@link createEncryptedTokenStore}.
 */
export interface EncryptedTokenStoreOptions {
  /**
   * Secret the encryption key is derived from. Must be a string of at least 32
   * characters and should come from a secret manager, not from source code. Every process
   * that shares the underlying store must use the same secret, and changing it makes
   * existing entries unreadable, which the cache treats as a miss.
   */
  secret: string;
}

/**
 * What a store writes the first time each kind of problem happens. Fixed text only, so no
 * token, key or error message can reach a log through it.
 */
const WARNINGS = {
  undecryptable:
    'An entry in the encrypted token store could not be decrypted and was treated as a cache miss. This is expected right after the secret changed. Otherwise check that every process sharing the store uses the same secret and that nothing else writes to it. Further entries like this are not logged again by this store.',
  binding:
    'An entry in the encrypted token store was found under a different key than it was written under and was treated as a cache miss. Check that nothing else writes to the underlying store. Further entries like this are not logged again by this store.',
  malformed:
    'An entry in the encrypted token store was malformed and was treated as a cache miss. Check that nothing else writes to the underlying store. Further entries like this are not logged again by this store.',
  inner:
    'The underlying store of the encrypted token store failed. The error is passed on to the caller, and the token client treats it as a cache miss. Further failures are not logged again by this store.',
} as const;

/** Injective encodings, so no pair of distinct keys can produce the same binding. */
const tokenBinding = (key: string): string => JSON.stringify(['t', key]);
const indexBinding = (indexKey: string, tokenKey: string): string => JSON.stringify(['i', indexKey, tokenKey]);

function isIndexed(store: TokenStore): store is IndexedTokenStore {
  const candidate = store as Partial<IndexedTokenStore>;
  return typeof candidate.addIndexMember === 'function' && typeof candidate.listIndexMembers === 'function';
}

async function deriveKey(secret: string): Promise<Uint8Array> {
  const material = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    material,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

/**
 * Wraps a {@link TokenStore} so that everything it holds is encrypted at rest.
 *
 * Use it in front of any store that persists or shares tokens, such as one backed by a
 * database or a cache server. Token values are sealed as compact JWE (`dir` with
 * `A256CBC-HS512`) using a key derived from `secret` with HKDF-SHA-256. The inner store
 * never sees an access token in the clear.
 *
 * ## Secret
 *
 * The secret should be at least 32 random bytes from a secret manager, for example the
 * base64 or hex encoding of 32 random bytes. The length check counts characters and cannot
 * measure entropy, so a long but guessable string passes the check and is still weak. Only
 * one secret is supported and there is no rotation yet: changing it makes every existing
 * entry unreadable, which the cache treats as a miss.
 *
 * ## What is and is not protected
 *
 * Each ciphertext is bound, through its authenticated protected header, to the storage key
 * it was written under. A ciphertext copied to a different key fails to decrypt and reads
 * as a miss. Each token entry also repeats its expiry time inside the sealed payload, and a
 * read whose plaintext expiry differs from the sealed one is a miss.
 *
 * Stored in the clear, because the cache needs it to find entries: the storage keys, each
 * entry's expiry time (so the inner store can apply its own time to live), and the token
 * key and expiry of each index member. Storage keys are opaque hashes that carry no claim
 * value, but they are stable pseudonymous identifiers for a given caller. The granted
 * scopes of an index member are encrypted, so the inner indexed store must treat index
 * members as opaque: their `grantedScopes` hold ciphertext, not scope names.
 *
 * Encryption does not defend against someone with write access to the inner store. They
 * can delete entries, or replay an older ciphertext under the same key until it expires,
 * which is still bounded by the expiry sealed inside it.
 *
 * ## Failures
 *
 * An entry that cannot be read is a cache miss, not an error. Tampered or malformed
 * ciphertext, a different secret or a key mismatch produces a miss, never an exception, so
 * the caller falls back to a fresh token exchange and access is never widened. Each kind of
 * unreadable entry writes one `console.warn` line per store instance, the first time it
 * happens, so a wrong or changed secret shows up in the logs instead of silently turning
 * every read into a miss. The line holds fixed text only: no value, key or error message.
 *
 * Failures raised by the inner store itself are not swallowed here. They are reported the
 * same way (once) and then rethrown unchanged, so an inner write failure propagates to the
 * caller of this store. The token client treats any error from a store as a miss.
 *
 * The returned store has index methods when `inner` does. This is decided at run time by
 * the presence of the methods, so an indexed store typed as a plain {@link TokenStore}
 * still yields a store with index methods.
 *
 * @param inner - The store that holds the encrypted values.
 * @param options - Encryption options.
 * @returns A store with the same interface as `inner`.
 * @throws {InvalidConfigurationError} When `secret` is not a string of at least 32
 * characters.
 */
export function createEncryptedTokenStore(inner: IndexedTokenStore, options: EncryptedTokenStoreOptions): IndexedTokenStore;
export function createEncryptedTokenStore(inner: TokenStore, options: EncryptedTokenStoreOptions): TokenStore;
export function createEncryptedTokenStore(inner: TokenStore, options: EncryptedTokenStoreOptions): TokenStore {
  const secret = options?.secret;

  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new InvalidConfigurationError(`secret must be a string of at least ${MIN_SECRET_LENGTH} characters.`);
  }

  let keyPromise: Promise<Uint8Array> | undefined;
  const getKey = (): Promise<Uint8Array> => {
    keyPromise ??= deriveKey(secret).catch((error: unknown) => {
      keyPromise = undefined;
      throw error;
    });
    return keyPromise;
  };

  const seal = async (plaintext: unknown, binding: string): Promise<string> =>
    new CompactEncrypt(encoder.encode(JSON.stringify(plaintext)))
      .setProtectedHeader({ alg: 'dir', enc: 'A256CBC-HS512', bnd: binding })
      .encrypt(await getKey());

  /** Reasons already reported by this store, so a persistent problem logs once per kind. */
  const reported = new Set<string>();
  const report = (reason: keyof typeof WARNINGS): void => {
    if (!reported.has(reason)) {
      reported.add(reason);
      warn(WARNINGS[reason]);
    }
  };

  /** Runs a call on the inner store, reporting a failure before it propagates unchanged. */
  const viaInner = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      report('inner');
      throw error;
    }
  };

  /** Returns the decrypted JSON value, or `undefined` for any failure. */
  const open = async (jwe: unknown, binding: string): Promise<unknown> => {
    if (typeof jwe !== 'string') {
      report('malformed');
      return undefined;
    }
    let plaintext: Uint8Array;
    try {
      const opened = await compactDecrypt(jwe, await getKey(), {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256CBC-HS512'],
      });
      if (opened.protectedHeader.bnd !== binding) {
        report('binding');
        return undefined;
      }
      plaintext = opened.plaintext;
    } catch {
      report('undecryptable');
      return undefined;
    }
    try {
      return JSON.parse(decoder.decode(plaintext));
    } catch {
      report('malformed');
      return undefined;
    }
  };

  const store: TokenStore = {
    async get(key) {
      const envelope: unknown = await viaInner(() => inner.get(key));
      if (envelope === undefined || envelope === null) {
        return undefined;
      }
      if (!isRecord(envelope)) {
        report('malformed');
        return undefined;
      }
      const value = await open(envelope.accessToken, tokenBinding(key));
      if (value === undefined) {
        return undefined;
      }
      // The plaintext expiry is what the inner store acts on, so it has to match the sealed one.
      if (!isCachedToken(value) || value.expiresAt !== envelope.expiresAt) {
        report('malformed');
        return undefined;
      }
      return value;
    },

    async set(key, value) {
      const envelope: CachedToken = {
        accessToken: await seal(value, tokenBinding(key)),
        expiresAt: value.expiresAt,
        grantedScopes: [],
      };
      await viaInner(() => inner.set(key, envelope));
    },

    delete(key) {
      return viaInner(() => inner.delete(key));
    },
  };

  if (!isIndexed(inner)) {
    return store;
  }

  const indexed: IndexedTokenStore = {
    ...store,

    async addIndexMember(indexKey, member) {
      const sealed = await seal(
        { grantedScopes: member.grantedScopes, expiresAt: member.expiresAt },
        indexBinding(indexKey, member.tokenKey)
      );
      await viaInner(() =>
        inner.addIndexMember(indexKey, {
          tokenKey: member.tokenKey,
          grantedScopes: [sealed],
          expiresAt: member.expiresAt,
        })
      );
    },

    async listIndexMembers(indexKey) {
      const stored: unknown = await viaInner(() => inner.listIndexMembers(indexKey));
      if (!Array.isArray(stored)) {
        report('malformed');
        return [];
      }
      const members: TokenIndexMember[] = [];
      for (const item of stored as unknown[]) {
        if (!isRecord(item) || typeof item.tokenKey !== 'string' || !Array.isArray(item.grantedScopes)) {
          report('malformed');
          continue;
        }
        const value = await open(item.grantedScopes[0], indexBinding(indexKey, item.tokenKey));
        if (value === undefined) {
          continue;
        }
        if (isRecord(value) && isStringArray(value.grantedScopes) && typeof value.expiresAt === 'number') {
          members.push({ tokenKey: item.tokenKey, grantedScopes: value.grantedScopes, expiresAt: value.expiresAt });
        } else {
          report('malformed');
        }
      }
      return members;
    },
  };

  return indexed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCachedToken(value: unknown): value is CachedToken {
  return (
    isRecord(value) &&
    typeof value.accessToken === 'string' &&
    typeof value.expiresAt === 'number' &&
    isStringArray(value.grantedScopes)
  );
}
