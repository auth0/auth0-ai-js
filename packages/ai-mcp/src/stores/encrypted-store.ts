import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import type { CachedToken, IndexedTokenStore, TokenIndexMember, TokenStore } from '@auth0/auth0-api-js';
import { CompactEncrypt, compactDecrypt } from 'jose';

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
 * Encryption does not defend against an attacker with write access to the inner store.
 * Such an attacker can delete entries, or replay an older ciphertext under the same key
 * until it expires, which is still bounded by the expiry sealed inside it.
 *
 * ## Failures
 *
 * Reads fail open. Tampered or malformed ciphertext, a different secret or a key mismatch
 * produces a miss, never an exception, and nothing about the value is logged. Failures
 * raised by the inner store itself are not swallowed here. Writes and deletes pass
 * through, so an inner write failure propagates to the caller.
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

  /** Returns the decrypted JSON value, or `undefined` for any failure. */
  const open = async (jwe: unknown, binding: string): Promise<unknown> => {
    try {
      if (typeof jwe !== 'string') {
        return undefined;
      }
      const { plaintext, protectedHeader } = await compactDecrypt(jwe, await getKey(), {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256CBC-HS512'],
      });
      if (protectedHeader.bnd !== binding) {
        return undefined;
      }
      return JSON.parse(decoder.decode(plaintext));
    } catch {
      return undefined;
    }
  };

  const store: TokenStore = {
    async get(key) {
      const envelope: unknown = await inner.get(key);
      if (!isRecord(envelope)) {
        return undefined;
      }
      const value = await open(envelope.accessToken, tokenBinding(key));
      // The plaintext expiry is what the inner store acts on, so it has to match the sealed one.
      return isCachedToken(value) && value.expiresAt === envelope.expiresAt ? value : undefined;
    },

    async set(key, value) {
      const envelope: CachedToken = {
        accessToken: await seal(value, tokenBinding(key)),
        expiresAt: value.expiresAt,
        grantedScopes: [],
      };
      await inner.set(key, envelope);
    },

    delete(key) {
      return inner.delete(key);
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
      await inner.addIndexMember(indexKey, {
        tokenKey: member.tokenKey,
        grantedScopes: [sealed],
        expiresAt: member.expiresAt,
      });
    },

    async listIndexMembers(indexKey) {
      const stored: unknown = await inner.listIndexMembers(indexKey);
      if (!Array.isArray(stored)) {
        return [];
      }
      const members: TokenIndexMember[] = [];
      for (const item of stored as unknown[]) {
        if (!isRecord(item) || typeof item.tokenKey !== 'string' || !Array.isArray(item.grantedScopes)) {
          continue;
        }
        const value = await open(item.grantedScopes[0], indexBinding(indexKey, item.tokenKey));
        if (isRecord(value) && isStringArray(value.grantedScopes) && typeof value.expiresAt === 'number') {
          members.push({ tokenKey: item.tokenKey, grantedScopes: value.grantedScopes, expiresAt: value.expiresAt });
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
