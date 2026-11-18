import type { CachedToken, TokenStore } from '@auth0/auth0-api-js';
import { warn } from './diagnostics.js';

const READ_FAILED =
  'The token store failed on a read for a client credentials or connection token. The read is treated as a cache miss. Further failures like this are not logged again by this client.';
const WRITE_FAILED =
  'The token store failed on a write for a client credentials or connection token. The token is still returned and is not cached. Further failures like this are not logged again by this client.';

/**
 * Wraps a store so a failing call is reported once per kind (read or write) with fixed text,
 * then rethrown unchanged. The core client treats a failed read as a cache miss and a failed
 * write as nothing to cache and logs nothing itself.
 *
 * The wrapper exposes only the three plain store methods and passes keys and values through
 * untouched. The text never contains a key, a token or text taken from the error.
 */
export function withFailureReport(store: TokenStore): TokenStore {
  const reported = new Set<'read' | 'write'>();
  const report = (kind: 'read' | 'write'): void => {
    if (reported.has(kind)) return;
    reported.add(kind);
    warn(kind === 'read' ? READ_FAILED : WRITE_FAILED);
  };
  return {
    async get(key: string): Promise<CachedToken | undefined> {
      try {
        return await store.get(key);
      } catch (error) {
        report('read');
        throw error;
      }
    },
    async set(key: string, value: CachedToken): Promise<void> {
      try {
        await store.set(key, value);
      } catch (error) {
        report('write');
        throw error;
      }
    },
    async delete(key: string): Promise<void> {
      try {
        await store.delete(key);
      } catch (error) {
        report('write');
        throw error;
      }
    },
  };
}
