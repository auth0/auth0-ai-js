import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import type { CachedToken, IndexedTokenStore, TokenIndexMember } from '@auth0/auth0-api-js';

/** Default upper bound on the number of cached tokens. */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Options for {@link MemoryIndexedTokenStore}.
 */
export interface MemoryIndexedTokenStoreOptions {
  /**
   * Largest number of tokens the store keeps. When a write would exceed it, the least
   * recently used token is evicted. The scope index is bounded by the same number: it never
   * holds more members than this, and a member is removed together with the token it points
   * at.
   *
   * Must be a positive safe integer. Defaults to 1000.
   */
  maxEntries?: number;
}

/**
 * An in-memory {@link IndexedTokenStore} with a hard size bound and least-recently-used
 * eviction.
 *
 * A reference store for a single process and for tests, which a server can opt into by
 * passing it as the `tokenStore`. It is not the default: no store is used unless one is
 * passed. The contents live in the memory of one process only: they are not shared between
 * processes or workers and are lost on exit. Use a store backed by shared storage, wrapped
 * with `createEncryptedTokenStore`, when several instances must see the same tokens.
 *
 * Values are copied when they are written and again when they are read, so neither the
 * caller that stored a value nor the caller that received one can change what the store
 * holds. Entries that have passed their expiry time are dropped lazily on access.
 */
export class MemoryIndexedTokenStore implements IndexedTokenStore {
  readonly #maxEntries: number;
  /** Token entries in least-recently-used order (oldest first). */
  readonly #tokens = new Map<string, CachedToken>();
  /** Index members keyed by index key, then token key. Outer map is in least-recently-used order. */
  readonly #indexes = new Map<string, Map<string, TokenIndexMember>>();
  /** For each token key, the index keys that hold a member pointing at it. */
  readonly #tokenToIndexes = new Map<string, Set<string>>();
  #memberCount = 0;

  /**
   * @param options - Store options.
   * @throws {InvalidConfigurationError} When `maxEntries` is not a positive safe integer.
   */
  constructor(options: MemoryIndexedTokenStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new InvalidConfigurationError('maxEntries must be a positive integer.');
    }

    this.#maxEntries = maxEntries;
  }

  /** The number of tokens currently held. Intended for diagnostics and tests. */
  get size(): number {
    return this.#tokens.size;
  }

  async get(key: string): Promise<CachedToken | undefined> {
    const entry = this.#tokens.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (isExpired(entry.expiresAt)) {
      this.#removeToken(key);
      return undefined;
    }

    // Refresh recency.
    this.#tokens.delete(key);
    this.#tokens.set(key, entry);

    return structuredClone(entry);
  }

  async set(key: string, value: CachedToken): Promise<void> {
    if (isExpired(value.expiresAt)) {
      this.#removeToken(key);
      return;
    }

    const copy = structuredClone(value);

    this.#tokens.delete(key);
    this.#tokens.set(key, copy);

    while (this.#tokens.size > this.#maxEntries) {
      const oldest = this.#tokens.keys().next().value as string;
      this.#removeToken(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.#removeToken(key);
  }

  async addIndexMember(indexKey: string, member: TokenIndexMember): Promise<void> {
    const copy = structuredClone(member);
    let members = this.#indexes.get(indexKey);

    if (members === undefined) {
      members = new Map();
    } else {
      this.#indexes.delete(indexKey); // Refresh recency.
    }
    this.#indexes.set(indexKey, members);

    if (members.has(copy.tokenKey)) {
      members.delete(copy.tokenKey);
      this.#memberCount--;
    }
    members.set(copy.tokenKey, copy);
    this.#memberCount++;

    let owners = this.#tokenToIndexes.get(copy.tokenKey);
    if (owners === undefined) {
      owners = new Set();
      this.#tokenToIndexes.set(copy.tokenKey, owners);
    }
    owners.add(indexKey);

    while (this.#memberCount > this.#maxEntries) {
      this.#evictOldestMember();
    }
  }

  async listIndexMembers(indexKey: string): Promise<TokenIndexMember[]> {
    const members = this.#indexes.get(indexKey);

    if (members === undefined) {
      return [];
    }

    // Refresh recency.
    this.#indexes.delete(indexKey);
    this.#indexes.set(indexKey, members);

    const result: TokenIndexMember[] = [];

    for (const [tokenKey, member] of [...members]) {
      if (isExpired(member.expiresAt)) {
        this.#removeMember(indexKey, tokenKey);
      } else {
        result.push(structuredClone(member));
      }
    }

    return result;
  }

  /** Removes a token and every index member that points at it. */
  #removeToken(key: string): void {
    this.#tokens.delete(key);

    const owners = this.#tokenToIndexes.get(key);
    if (owners !== undefined) {
      for (const indexKey of [...owners]) {
        this.#removeMember(indexKey, key);
      }
    }
  }

  #removeMember(indexKey: string, tokenKey: string): void {
    const members = this.#indexes.get(indexKey);

    if (members?.delete(tokenKey)) {
      this.#memberCount--;
      if (members.size === 0) {
        this.#indexes.delete(indexKey);
      }
    }

    const owners = this.#tokenToIndexes.get(tokenKey);
    if (owners !== undefined) {
      owners.delete(indexKey);
      if (owners.size === 0) {
        this.#tokenToIndexes.delete(tokenKey);
      }
    }
  }

  #evictOldestMember(): void {
    const oldestIndex = this.#indexes.entries().next().value as [string, Map<string, TokenIndexMember>];
    const [indexKey, members] = oldestIndex;
    const tokenKey = members.keys().next().value as string;
    this.#removeMember(indexKey, tokenKey);
  }
}

function isExpired(expiresAt: number): boolean {
  return typeof expiresAt === 'number' && expiresAt <= Math.floor(Date.now() / 1000);
}
