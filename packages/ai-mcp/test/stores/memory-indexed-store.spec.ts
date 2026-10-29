import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import type { CachedToken } from '@auth0/auth0-api-js';
import { MemoryIndexedTokenStore } from '../../src/stores/memory-indexed-store.js';

const now = () => Math.floor(Date.now() / 1000);

function token(overrides: Partial<CachedToken> = {}): CachedToken {
  return { accessToken: 'at', expiresAt: now() + 3600, grantedScopes: ['read'], ...overrides };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryIndexedTokenStore', () => {
  describe('options', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects maxEntries %s', (maxEntries) => {
      expect(() => new MemoryIndexedTokenStore({ maxEntries })).toThrowError(InvalidConfigurationError);
    });

    it('accepts no options', () => {
      expect(() => new MemoryIndexedTokenStore()).not.toThrow();
    });
  });

  describe('tokens', () => {
    it('returns undefined for an unknown key', async () => {
      expect(await new MemoryIndexedTokenStore().get('nope')).toBeUndefined();
    });

    it('round trips and deletes', async () => {
      const store = new MemoryIndexedTokenStore();
      const value = token({ scope: 'read', tokenType: 'bearer', issuedTokenType: 'x' });
      await store.set('k', value);
      expect(await store.get('k')).toEqual(value);
      await store.delete('k');
      expect(await store.get('k')).toBeUndefined();
    });

    it('does not let callers mutate stored state through the written reference', async () => {
      const store = new MemoryIndexedTokenStore();
      const value = token();
      await store.set('k', value);
      value.accessToken = 'changed';
      value.grantedScopes.push('admin');
      expect((await store.get('k'))?.accessToken).toBe('at');
      expect((await store.get('k'))?.grantedScopes).toEqual(['read']);
    });

    it('does not let callers mutate stored state through a returned reference', async () => {
      const store = new MemoryIndexedTokenStore();
      await store.set('k', token());
      const first = (await store.get('k'))!;
      first.accessToken = 'changed';
      first.grantedScopes.push('admin');
      const second = (await store.get('k'))!;
      expect(second.accessToken).toBe('at');
      expect(second.grantedScopes).toEqual(['read']);
    });

    it('drops expired entries on read', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const store = new MemoryIndexedTokenStore();
      await store.set('k', token({ expiresAt: now() + 10 }));
      expect(await store.get('k')).toBeDefined();
      vi.advanceTimersByTime(11_000);
      expect(await store.get('k')).toBeUndefined();
      expect(store.size).toBe(0);
    });

    it('does not store a value that has already expired', async () => {
      const store = new MemoryIndexedTokenStore();
      await store.set('k', token({ expiresAt: now() - 1 }));
      expect(store.size).toBe(0);
      expect(await store.get('k')).toBeUndefined();
    });

    it('evicts the least recently used token beyond maxEntries', async () => {
      const store = new MemoryIndexedTokenStore({ maxEntries: 2 });
      await store.set('a', token({ accessToken: 'a' }));
      await store.set('b', token({ accessToken: 'b' }));
      await store.get('a'); // a is now the most recently used
      await store.set('c', token({ accessToken: 'c' }));

      expect(store.size).toBe(2);
      expect(await store.get('b')).toBeUndefined();
      expect((await store.get('a'))?.accessToken).toBe('a');
      expect((await store.get('c'))?.accessToken).toBe('c');
    });

    it('never grows past maxEntries', async () => {
      const store = new MemoryIndexedTokenStore({ maxEntries: 5 });
      for (let i = 0; i < 50; i++) {
        await store.set(`k${i}`, token());
      }
      expect(store.size).toBe(5);
    });
  });

  describe('index', () => {
    const member = (tokenKey: string, extra: Partial<{ expiresAt: number; grantedScopes: string[] }> = {}) => ({
      tokenKey,
      grantedScopes: ['read'],
      expiresAt: now() + 3600,
      ...extra,
    });

    it('returns an empty list for an unknown index', async () => {
      expect(await new MemoryIndexedTokenStore().listIndexMembers('i')).toEqual([]);
    });

    it('adds members and replaces one with the same token key', async () => {
      const store = new MemoryIndexedTokenStore();
      await store.addIndexMember('i', member('t1'));
      await store.addIndexMember('i', member('t2'));
      await store.addIndexMember('i', member('t1', { grantedScopes: ['read', 'write'] }));

      const members = await store.listIndexMembers('i');
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.tokenKey === 't1')?.grantedScopes).toEqual(['read', 'write']);
    });

    it('isolates indexes from each other', async () => {
      const store = new MemoryIndexedTokenStore();
      await store.addIndexMember('i1', member('t1'));
      expect(await store.listIndexMembers('i2')).toEqual([]);
    });

    it('does not let callers mutate stored members', async () => {
      const store = new MemoryIndexedTokenStore();
      const input = member('t1');
      await store.addIndexMember('i', input);
      input.grantedScopes.push('admin');
      const listed = await store.listIndexMembers('i');
      listed[0].grantedScopes.push('admin');
      expect((await store.listIndexMembers('i'))[0].grantedScopes).toEqual(['read']);
    });

    it('drops expired members when listing', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const store = new MemoryIndexedTokenStore();
      await store.addIndexMember('i', member('t1', { expiresAt: now() + 5 }));
      await store.addIndexMember('i', member('t2'));
      vi.advanceTimersByTime(6_000);
      expect((await store.listIndexMembers('i')).map((m) => m.tokenKey)).toEqual(['t2']);
    });

    it('removes members when the token they point at is deleted', async () => {
      const store = new MemoryIndexedTokenStore();
      await store.set('t1', token());
      await store.addIndexMember('i', member('t1'));
      await store.delete('t1');
      expect(await store.listIndexMembers('i')).toEqual([]);
    });

    it('removes members when the token they point at is evicted', async () => {
      const store = new MemoryIndexedTokenStore({ maxEntries: 1 });
      await store.set('t1', token());
      await store.addIndexMember('i', member('t1'));
      await store.set('t2', token());
      expect(await store.listIndexMembers('i')).toEqual([]);
    });

    it('removes members when the token they point at expires on read', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const store = new MemoryIndexedTokenStore();
      await store.set('t1', token({ expiresAt: now() + 5 }));
      await store.addIndexMember('i', member('t1', { expiresAt: now() + 3600 }));
      vi.advanceTimersByTime(6_000);
      await store.get('t1');
      expect(await store.listIndexMembers('i')).toEqual([]);
    });

    it('evicts the least recently used index when maxEntries is reached across indexes', async () => {
      const store = new MemoryIndexedTokenStore({ maxEntries: 1 });
      await store.addIndexMember('i1', member('t1'));
      await store.addIndexMember('i2', member('t2'));
      expect(await store.listIndexMembers('i1')).toEqual([]);
      expect((await store.listIndexMembers('i2')).map((m) => m.tokenKey)).toEqual(['t2']);
    });

    it('bounds the total number of members even when no token backs them', async () => {
      const store = new MemoryIndexedTokenStore({ maxEntries: 3 });
      for (let i = 0; i < 20; i++) {
        await store.addIndexMember(`i${i % 4}`, member(`t${i}`));
      }
      let total = 0;
      for (let i = 0; i < 4; i++) {
        total += (await store.listIndexMembers(`i${i}`)).length;
      }
      expect(total).toBe(3);
    });
  });
});
