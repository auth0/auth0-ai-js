# Token caching

Caching of On Behalf Of tokens is optional and off by default. Without a `tokenStore`, every call to `getTokenOnBehalfOf` performs a fresh exchange and nothing persists anywhere.

To enable it, pass a token store to `createMcpClient`:

```ts
import { MemoryIndexedTokenStore, createMcpClient } from '@auth0/ai-mcp';

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  tokenStore: new MemoryIndexedTokenStore({ maxEntries: 5000 }),
  scopeMatching: 'strict',
});
```

The package caches only On Behalf Of tokens. It requests client credentials tokens and Token Vault tokens every time.

## The store interface

A `TokenStore` has three asynchronous methods. `@auth0/ai-mcp` exports the types.

| Method | Purpose |
| --- | --- |
| `get(key)` | Returns the `CachedToken` stored under `key`, or `undefined`. |
| `set(key, value)` | Stores `value` under `key`. |
| `delete(key)` | Removes the entry. |

A `CachedToken` holds the access token, its `expiresAt` (epoch seconds), the `grantedScopes`, and optional `scope`, `tokenType` and `issuedTokenType`.

The package ships two stores:

- `MemoryIndexedTokenStore`: an in-memory store with a hard size limit (`maxEntries`, default 1000) and least-recently-used eviction. It lives in the memory of one process, so it is not shared between workers and does not survive a restart. It copies values on write and on read, and drops expired entries lazily.
- `createEncryptedTokenStore`: wraps any store so that it holds only encrypted values. See [Encrypted store](#encrypted-store).

For several instances that must share tokens, implement the interface on top of shared storage such as Redis and wrap it with `createEncryptedTokenStore`.

## Cache keys

The package, not the store, builds the keys. A key combines:

- the tenant, client and audience that perform the exchange,
- the subject token's issuer, client, subject and organization,
- the session of the subject token (its `sid` claim, else `jti`, else a digest of the token),
- the audience you request, and
- the normalized scope set.

Because the subject is part of the key, one caller's token is never returned for another caller, and the session is part of the key, so separate sessions of the same user stay apart. Keys are opaque hashes that carry no claim value, but they are stable pseudonymous identifiers, so treat the store as sensitive.

## Scope matching

`scopeMatching` controls when a cached token counts as a hit. Both modes compare the scopes the exchange was **granted**, never the scopes a previous call requested.

- `'strict'` (default): reuse a token only when its granted scopes are exactly the requested set.
- `'non_strict'`: also reuse a token whose granted scopes cover the requested set, preferring the smallest such token. Several tokens then coexist per caller, so the store has to be searched rather than looked up. A request for no scopes never reuses a cached token in this mode.

`'strict'` never widens access silently. Use `'non_strict'` when your tools request overlapping scope sets and you want to avoid repeated exchanges.

`'non_strict'` needs an `IndexedTokenStore`, which adds two methods:

- `addIndexMember(indexKey, member)` adds a `TokenIndexMember` (`tokenKey`, `grantedScopes`, `expiresAt`), replacing any member with the same `tokenKey`. It must be atomic. Two concurrent exchanges for the same caller can add to the same index at once, and a read-modify-write without a lock loses one of them. A Redis hash field write is an example of an atomic operation.
- `listIndexMembers(indexKey)` returns every member, or `[]` when the index does not exist. It may include expired members, which the package skips on read.

`createMcpClient` throws `InvalidConfigurationError` at construction when `scopeMatching` is `'non_strict'` and the store is missing or not indexed. When you pass your own `apiClient` the check cannot run, and the core client reports the mismatch on the first token request.

```ts
import { MemoryIndexedTokenStore, createMcpClient } from '@auth0/ai-mcp';

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  tokenStore: new MemoryIndexedTokenStore(),
  scopeMatching: 'non_strict',
});
```

The index is a hint kept next to the data, not an authority. The package considers a member only when the key it points at is exactly the key this caller would have written for the scopes the member claims.

## What a hit looks like

- Both modes cache a token under the scopes Auth0 granted it, including a token whose grant came back narrower than the request. The caller that asked for more still gets `DownscopedTokenError`. See [On Behalf Of](./OnBehalfOf.md#narrowed-grants).
- A token within five seconds of its expiry counts as a miss.
- Store failures never fail a tool call. A read that throws counts as a miss, and the package ignores a write that throws, so the freshly exchanged token is still returned. A store outage costs extra exchanges.
- The package never deletes entries. Your store must expire them, using each value's `expiresAt`. For an index, expire the whole index key and push its expiry out to the latest member's `expiresAt` on every add.

## Encrypted store

`createEncryptedTokenStore(inner, { secret })` returns a store with the same interface as `inner`, and index methods when `inner` has them. The wrapper seals everything before it writes to `inner`, so the inner store never sees an access token in the clear.

```ts
import { MemoryIndexedTokenStore, createEncryptedTokenStore, createMcpClient } from '@auth0/ai-mcp';

const secret = process.env.TOKEN_STORE_SECRET;
if (secret === undefined) {
  throw new Error('TOKEN_STORE_SECRET is not set.');
}

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  tokenStore: createEncryptedTokenStore(new MemoryIndexedTokenStore(), { secret }),
  scopeMatching: 'non_strict',
});
```

**Secret.** `secret` must be a string of at least 32 characters, otherwise the call throws `InvalidConfigurationError`. The check counts characters and cannot measure entropy, so a long but guessable string passes it and is still weak. Use 32 random bytes from a secret manager, for example the hex or base64 encoding of them. Every process that shares the inner store must use the same secret.

**Format.** The wrapper seals values as compact JWE (`dir` with `A256CBC-HS512`) with a key it derives from the secret using HKDF-SHA-256. The authenticated header binds each ciphertext to the storage key it was written under, so a ciphertext copied to another key fails to decrypt and reads as a miss. The sealed payload repeats the token's expiry, and the wrapper checks it on read.

**What stays readable.** The storage keys, each entry's expiry time, and the token key and expiry of each index member remain in the clear, because the inner store needs them to find and expire entries. The wrapper encrypts the granted scopes of an index member, so the inner indexed store must treat members as opaque: their `grantedScopes` hold ciphertext, not scope names.

**Failures.** Reads fail open: tampered or malformed ciphertext, a different secret or a key mismatch produces a miss, never an exception, and the wrapper logs nothing about the value. Failures raised by the inner store are not swallowed by the wrapper. The core client then treats them as described above.

**What it does not protect against.** An attacker with write access to the inner store can delete entries or replay an older ciphertext under the same key until it expires. Encryption does not defend against that. There is also no secret rotation. See [known limitations](./KnownLimitations.md#the-encrypted-store-has-no-secret-rotation).

## Writing a store

A store on shared storage implements `TokenStore`, or `IndexedTokenStore` for `'non_strict'`. This sketch uses a minimal Redis-shaped client:

```ts
import { createEncryptedTokenStore } from '@auth0/ai-mcp';
import type { CachedToken, IndexedTokenStore, TokenIndexMember } from '@auth0/ai-mcp';

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expireat(key: string, epochSeconds: number): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hvals(key: string): Promise<string[]>;
}

class RedisTokenStore implements IndexedTokenStore {
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<CachedToken | undefined> {
    const raw = await this.redis.get(`mcp:token:${key}`);
    return raw === null ? undefined : (JSON.parse(raw) as CachedToken);
  }

  async set(key: string, value: CachedToken): Promise<void> {
    await this.redis.set(`mcp:token:${key}`, JSON.stringify(value));
    await this.redis.expireat(`mcp:token:${key}`, value.expiresAt);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`mcp:token:${key}`);
  }

  async addIndexMember(indexKey: string, member: TokenIndexMember): Promise<void> {
    const key = `mcp:index:${indexKey}`;
    await this.redis.hset(key, member.tokenKey, JSON.stringify(member));
    // Keep the index alive as long as its newest token.
    const members = await this.listIndexMembers(indexKey);
    const latest = Math.max(member.expiresAt, ...members.map((entry) => entry.expiresAt));
    await this.redis.expireat(key, latest);
  }

  async listIndexMembers(indexKey: string): Promise<TokenIndexMember[]> {
    const values = await this.redis.hvals(`mcp:index:${indexKey}`);
    return values.map((value) => JSON.parse(value) as TokenIndexMember);
  }
}

export function createSharedStore(redis: RedisLike, secret: string): IndexedTokenStore {
  return createEncryptedTokenStore(new RedisTokenStore(redis), { secret });
}
```

Stores must expire entries on their own: set a time to live that matches `expiresAt` when you write.

## Observing exchanges

The package has no hook that reports whether a call used the cache. You can measure it yourself, because `createMcpClient` accepts a pre-built `apiClient` and the core client accepts a `customFetch`. Count the requests to the token endpoint, and bind one record to each tool call with `AsyncLocalStorage`. A call that makes no token request used the cache or needed no exchange.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiClient } from '@auth0/auth0-api-js';
import { MemoryIndexedTokenStore, createMcpClient } from '@auth0/ai-mcp';

interface CallRecord {
  exchanges: number;
}

const records = new AsyncLocalStorage<CallRecord>();

const countingFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).pathname === '/oauth/token') {
    const record = records.getStore();
    if (record) record.exchanges += 1;
  }
  // A custom fetch replaces the client's default 10 s timeout, so set one here.
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
};

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  tokenStore: new MemoryIndexedTokenStore({ maxEntries: 5000 }),
  apiClient: new ApiClient({
    domain: 'your-tenant.us.auth0.com',
    audience: 'https://mcp.example.com/mcp',
    clientId: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
    customFetch: countingFetch,
  }),
});

export async function observe<T>(tool: string, run: () => Promise<T>): Promise<T> {
  const record: CallRecord = { exchanges: 0 };
  const started = Date.now();
  let outcome = 'ok';
  try {
    return await records.run(record, run);
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    console.log(JSON.stringify({ tool, outcome, durationMs: Date.now() - started, exchanges: record.exchanges }));
  }
}
```

Wrap each tool body in `observe('list_reports', ...)`. The log line holds the tool name, the outcome, the duration and the exchange count, and nothing else. Do not add arguments, tokens, headers or user data to it.

Limits of this approach:

- The count shows that no exchange happened inside the call. It cannot tell a cache hit from a call that needed no exchange.
- A call that joins another call's in-flight exchange also shows zero exchanges. The token request runs in the context of the call that started it, so only that call counts it.
- Your own client replaces the settings that `createMcpClient` would otherwise build, including the request timeout. Set them on the `ApiClient`, as described in [On Behalf Of and client credentials](./OnBehalfOf.md).
