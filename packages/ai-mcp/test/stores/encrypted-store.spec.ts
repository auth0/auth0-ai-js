import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { ApiClient } from '@auth0/auth0-api-js';
import { createAuth0Handlers, createTestKey, mintAccessToken } from '../support/index.js';
import type { TestKey } from '../support/index.js';
import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import type { CachedToken, IndexedTokenStore, TokenStore } from '@auth0/auth0-api-js';
import { createEncryptedTokenStore } from '../../src/stores/encrypted-store.js';
import { MemoryIndexedTokenStore } from '../../src/stores/memory-indexed-store.js';

const SECRET = 'a-secret-that-is-at-least-32-characters-long';
const OTHER_SECRET = 'a-different-secret-with-32-or-more-characters';
const ACCESS_TOKEN = 'eyJ.super-secret-access-token.sig';

const value = (): CachedToken => ({
  accessToken: ACCESS_TOKEN,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  grantedScopes: ['read:data', 'write:data'],
  scope: 'read:data write:data',
  tokenType: 'bearer',
  issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
});

/** A plain record-keeping store that exposes its raw contents. */
class RawStore implements IndexedTokenStore {
  tokens = new Map<string, CachedToken>();
  indexes = new Map<string, import('@auth0/auth0-api-js').TokenIndexMember[]>();
  async get(key: string) {
    return this.tokens.get(key);
  }
  async set(key: string, v: CachedToken) {
    this.tokens.set(key, v);
  }
  async delete(key: string) {
    this.tokens.delete(key);
  }
  async addIndexMember(indexKey: string, member: import('@auth0/auth0-api-js').TokenIndexMember) {
    const list = (this.indexes.get(indexKey) ?? []).filter((m) => m.tokenKey !== member.tokenKey);
    list.push(member);
    this.indexes.set(indexKey, list);
  }
  async listIndexMembers(indexKey: string) {
    return this.indexes.get(indexKey) ?? [];
  }
}

class PlainStore implements TokenStore {
  tokens = new Map<string, CachedToken>();
  async get(key: string) {
    return this.tokens.get(key);
  }
  async set(key: string, v: CachedToken) {
    this.tokens.set(key, v);
  }
  async delete(key: string) {
    this.tokens.delete(key);
  }
}

/** Flips one character in the middle of the ciphertext segment of a compact JWE. */
function tamper(jwe: string): string {
  const parts = jwe.split('.');
  const ct = parts[3];
  const mid = Math.floor(ct.length / 2);
  parts[3] = ct.slice(0, mid) + (ct[mid] === 'A' ? 'B' : 'A') + ct.slice(mid + 1);
  return parts.join('.');
}

describe('createEncryptedTokenStore', () => {
  describe('secret validation', () => {
    it.each([['short', 'x'.repeat(31)], ['empty', ''], ['number', 123 as unknown as string], ['undefined', undefined as unknown as string]])(
      'throws synchronously for a %s secret without echoing it',
      (_name, secret) => {
        let error: unknown;
        try {
          createEncryptedTokenStore(new PlainStore(), { secret });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(InvalidConfigurationError);
        if (typeof secret === 'string' && secret.length > 0) {
          expect((error as Error).message).not.toContain(secret);
        }
      }
    );

    it('accepts a 32 character secret', () => {
      expect(() => createEncryptedTokenStore(new PlainStore(), { secret: 'x'.repeat(32) })).not.toThrow();
    });
  });

  describe('tokens', () => {
    it('round trips a value', async () => {
      const store = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      const v = value();
      await store.set('k', v);
      expect(await store.get('k')).toEqual(v);
    });

    it('returns undefined for an unknown key', async () => {
      const store = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      expect(await store.get('nope')).toBeUndefined();
    });

    it('delete passes through', async () => {
      const store = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      await store.set('k', value());
      await store.delete('k');
      expect(await store.get('k')).toBeUndefined();
    });

    it('never gives the inner store the access token or scopes in the clear', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.set('k', value());
      await store.addIndexMember('idx', { tokenKey: 'k', grantedScopes: ['read:data'], expiresAt: value().expiresAt });

      const raw = JSON.stringify([[...inner.tokens], [...inner.indexes]]);
      expect(raw).not.toContain(ACCESS_TOKEN);
      expect(raw).not.toContain('read:data');
      expect(raw).not.toContain('write:data');
    });

    it('keeps the expiry visible to the inner store so it can apply a time to live', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      const v = value();
      await store.set('k', v);
      expect(inner.tokens.get('k')?.expiresAt).toBe(v.expiresAt);
    });

    it('treats a tampered ciphertext as a miss', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.set('k', value());
      const stored = inner.tokens.get('k')!;
      inner.tokens.set('k', { ...stored, accessToken: tamper(stored.accessToken) });
      expect(await store.get('k')).toBeUndefined();
    });

    it('treats a value written under another secret as a miss', async () => {
      const inner = new RawStore();
      await createEncryptedTokenStore(inner, { secret: SECRET }).set('k', value());
      expect(await createEncryptedTokenStore(inner, { secret: OTHER_SECRET }).get('k')).toBeUndefined();
    });

    it('treats a ciphertext moved to another key as a miss', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.set('a', value());
      inner.tokens.set('b', inner.tokens.get('a')!);
      expect(await store.get('b')).toBeUndefined();
      expect(await store.get('a')).toBeDefined();
    });

    it('treats an entry whose plaintext expiry differs from the sealed expiry as a miss', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.set('k', value());
      const stored = inner.tokens.get('k')!;
      inner.tokens.set('k', { ...stored, expiresAt: stored.expiresAt + 86_400 });
      expect(await store.get('k')).toBeUndefined();
    });

    it('binds token ciphertexts injectively as well as by key', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.set('a:b', value());
      inner.tokens.set('b', inner.tokens.get('a:b')!);
      inner.tokens.set('a', inner.tokens.get('a:b')!);
      expect(await store.get('b')).toBeUndefined();
      expect(await store.get('a')).toBeUndefined();
    });

    it('recovers when key derivation fails once', async () => {
      const store = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      const spy = vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('transient'));
      await expect(store.set('k', value())).rejects.toThrow('transient');
      spy.mockRestore();
      await store.set('k', value());
      expect(await store.get('k')).toEqual(value());
    });

    it.each([
      ['plaintext cached token', { accessToken: ACCESS_TOKEN, expiresAt: 1, grantedScopes: [] }],
      ['non-string accessToken', { accessToken: 5, expiresAt: 1, grantedScopes: [] }],
      ['null', null],
      ['string', 'garbage'],
    ])('treats a malformed inner value (%s) as a miss', async (_name, bad) => {
      const inner = new RawStore();
      inner.tokens.set('k', bad as unknown as CachedToken);
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      expect(await store.get('k')).toBeUndefined();
    });

    it('does not swallow a failure raised by the inner store', async () => {
      const inner = new RawStore();
      inner.get = async () => {
        throw new Error('backend down');
      };
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await expect(store.get('k')).rejects.toThrow('backend down');
    });
  });

  describe('index', () => {
    it('round trips members', async () => {
      const store = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      const member = { tokenKey: 't1', grantedScopes: ['a', 'b'], expiresAt: 4_000_000_000 };
      await store.addIndexMember('idx', member);
      expect(await store.listIndexMembers('idx')).toEqual([member]);
    });

    it('replaces a member with the same token key', async () => {
      const store = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      await store.addIndexMember('idx', { tokenKey: 't1', grantedScopes: ['a'], expiresAt: 4_000_000_000 });
      await store.addIndexMember('idx', { tokenKey: 't1', grantedScopes: ['a', 'b'], expiresAt: 4_000_000_000 });
      const listed = await store.listIndexMembers('idx');
      expect(listed).toHaveLength(1);
      expect(listed[0].grantedScopes).toEqual(['a', 'b']);
    });

    it('returns an empty list for an unknown index', async () => {
      const store = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      expect(await store.listIndexMembers('idx')).toEqual([]);
    });

    it('drops a tampered member and keeps the others', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.addIndexMember('idx', { tokenKey: 't1', grantedScopes: ['a'], expiresAt: 4_000_000_000 });
      await store.addIndexMember('idx', { tokenKey: 't2', grantedScopes: ['b'], expiresAt: 4_000_000_000 });
      const list = inner.indexes.get('idx')!;
      list[0] = { ...list[0], grantedScopes: [tamper(list[0].grantedScopes[0])] };
      expect((await store.listIndexMembers('idx')).map((m) => m.tokenKey)).toEqual(['t2']);
    });

    it('drops a member copied under another index or token key', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.addIndexMember('idx', { tokenKey: 't1', grantedScopes: ['admin'], expiresAt: 4_000_000_000 });
      const original = inner.indexes.get('idx')![0];
      inner.indexes.set('other', [original]);
      inner.indexes.set('idx2', [{ ...original, tokenKey: 'victim' }]);
      expect(await store.listIndexMembers('other')).toEqual([]);
      expect(await store.listIndexMembers('idx2')).toEqual([]);
    });

    it('drops a plaintext member injected into the inner store', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      inner.indexes.set('idx', [{ tokenKey: 't1', grantedScopes: ['admin'], expiresAt: 4_000_000_000 }]);
      expect(await store.listIndexMembers('idx')).toEqual([]);
    });

    it('ignores a malformed index listing from the inner store', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      inner.listIndexMembers = async () => 'garbage' as unknown as [];
      expect(await store.listIndexMembers('idx')).toEqual([]);

      inner.listIndexMembers = async () =>
        [null, { tokenKey: 5, grantedScopes: [] }, { tokenKey: 't', grantedScopes: 'x' }] as unknown as [];
      expect(await store.listIndexMembers('idx')).toEqual([]);
    });

    it('reads as empty when listed under a different secret', async () => {
      const inner = new RawStore();
      await createEncryptedTokenStore(inner, { secret: SECRET }).addIndexMember('idx', {
        tokenKey: 't1',
        grantedScopes: ['a'],
        expiresAt: 4_000_000_000,
      });
      expect(await createEncryptedTokenStore(inner, { secret: OTHER_SECRET }).listIndexMembers('idx')).toEqual([]);
    });

    it('binds members injectively, so keys that differ only where a colon moves do not collide', async () => {
      const inner = new RawStore();
      const store = createEncryptedTokenStore(inner, { secret: SECRET });
      await store.addIndexMember('a:b', { tokenKey: 'c', grantedScopes: ['admin'], expiresAt: 4_000_000_000 });
      const original = inner.indexes.get('a:b')![0];
      inner.indexes.set('a', [{ ...original, tokenKey: 'b:c' }]);
      expect(await store.listIndexMembers('a')).toEqual([]);
      expect(await store.listIndexMembers('a:b')).toHaveLength(1);
    });

    it('works on top of the in-memory indexed store', async () => {
      const store = createEncryptedTokenStore(new MemoryIndexedTokenStore(), { secret: SECRET });
      const v = value();
      await store.set('k', v);
      await store.addIndexMember('idx', { tokenKey: 'k', grantedScopes: v.grantedScopes, expiresAt: v.expiresAt });
      expect(await store.get('k')).toEqual(v);
      expect(await store.listIndexMembers('idx')).toHaveLength(1);
    });
  });

  describe('shape', () => {
    it('exposes index methods only when the inner store has them', () => {
      const plain = createEncryptedTokenStore(new PlainStore(), { secret: SECRET }) as Partial<IndexedTokenStore>;
      expect(plain.addIndexMember).toBeUndefined();
      expect(plain.listIndexMembers).toBeUndefined();

      const indexed = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      expect(typeof indexed.addIndexMember).toBe('function');
      expect(typeof indexed.listIndexMembers).toBe('function');
    });

    it('types an indexed inner store as indexed', () => {
      const indexed: IndexedTokenStore = createEncryptedTokenStore(new RawStore(), { secret: SECRET });
      expect(indexed).toBeDefined();
    });
  });
});

describe('createEncryptedTokenStore with ApiClient in non_strict mode', () => {
  const AUDIENCE = 'https://api.example.com';
  const DOWNSTREAM = 'https://downstream.example.com';
  const server = setupServer();
  let key: TestKey;

  beforeAll(async () => {
    key = await createTestKey();
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('serves a narrower request from a cached superset and exchanges once', async () => {
    const auth0 = createAuth0Handlers({ key });
    server.use(...auth0.handlers);
    const store = createEncryptedTokenStore(new MemoryIndexedTokenStore(), { secret: SECRET });
    const client = new ApiClient({
      domain: 'tenant.example.com',
      audience: AUDIENCE,
      clientId: 'client-1',
      clientSecret: 'client-secret',
      scopeMatching: 'non_strict',
    });
    const subject = await mintAccessToken(key, { iss: auth0.issuer, aud: AUDIENCE, sub: 'user|1' });

    const wide = await client.getTokenOnBehalfOf(subject, { audience: DOWNSTREAM, scope: 'read write' }, { store });
    const narrow = await client.getTokenOnBehalfOf(subject, { audience: DOWNSTREAM, scope: 'read' }, { store });

    expect(auth0.state.exchangeCount).toBe(1);
    expect(narrow.accessToken).toBe(wide.accessToken);
  });
});
