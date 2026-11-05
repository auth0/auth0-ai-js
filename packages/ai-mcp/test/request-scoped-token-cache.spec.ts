import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { ApiClient, InvalidScopeError } from '@auth0/auth0-api-js';
import type { CachedToken, TokenStore, VerifiedToken } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import { DownscopedTokenError, UnauthenticatedError } from '../src/errors.js';
import { createRequestScopedClient } from '../src/request-scoped-client.js';
import type { ExchangeIdentity } from '../src/request-scoped-client.js';
import { SingleFlight } from '../src/single-flight.js';
import { createTokenCache } from '../src/token-cache.js';
import { createEncryptedTokenStore } from '../src/stores/encrypted-store.js';
import type { McpClient, VerifiedCaller } from '../src/client.js';
import type { Principal, RequestScopedMcpClient } from '../src/types.js';
import { createAuth0Handlers, createTestKey, mintAccessToken } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';
const SECRET = 'a-secret-that-is-at-least-32-characters-long';
const M2M_PREFIX = 'a0.mcp.m2m.v1.';
const TV_PREFIX = 'a0.mcp.tv.v1.';
const KEYED_CLAIMS = ['iss', 'client_id', 'azp', 'sub', 'org_id', 'sid', 'jti'];

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();
let warn: MockInstance<typeof console.warn>;
const logged = () => warn.mock.calls.map((call) => String(call[0])).join('\n');

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
});
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  tenant = createAuth0Handlers({ key });
  server.use(...tenant.handlers);
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  warn.mockRestore();
});
afterAll(() => server.close());

/** A store that keeps what it is given by reference, like a careless store would, and can be made to fail. */
class RecordingStore implements TokenStore {
  readonly entries = new Map<string, unknown>();
  gets = 0;
  sets = 0;
  failGet = false;
  failSet = false;
  onSet: ((value: CachedToken) => void) | undefined;
  async get(k: string) {
    this.gets++;
    if (this.failGet) throw new Error('backend down STORE-SECRET');
    return this.entries.get(k) as CachedToken | undefined;
  }
  async set(k: string, v: CachedToken) {
    this.sets++;
    if (this.failSet) throw new Error('backend down STORE-SECRET');
    this.onSet?.(v);
    this.entries.set(k, v);
  }
  async delete(k: string) {
    this.entries.delete(k);
  }
  keys(prefix: string): string[] {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix));
  }
}

function makeClient(extra: Partial<Parameters<typeof createMcpClient>[0]> = {}): McpClient {
  return createMcpClient({
    domain: 'tenant.example.com',
    audience: AUDIENCE,
    clientId: 'mcp-client',
    clientSecret: 'secret',
    ...extra,
  });
}

async function caller(
  client: McpClient,
  sub = 'user|1',
  claims: Record<string, unknown> = {}
): Promise<VerifiedCaller> {
  const accessToken = await mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub, scope: 'openid', claims });
  return client.verifyAccessToken({ accessToken });
}

async function scopedFor(client: McpClient, sub = 'user|1', claims: Record<string, unknown> = {}) {
  return client.withToken(await caller(client, sub, claims));
}

interface EndpointOptions {
  /** `expires_in` of issued tokens. `null` leaves the field out. Defaults to 7200. */
  expiresIn?: number | null;
  delayMs?: number;
  /** Scope the endpoint reports. Defaults to the requested scope, when there is one. */
  scope?: string;
  /** Leave the `scope` field out of the response. */
  omitScope?: boolean;
}

/** A token endpoint for one grant that counts its requests and can be slowed down or made to fail. */
function useEndpoint(kind: 'client_credentials' | 'connection', options: EndpointOptions = {}) {
  const control = {
    requests: [] as Record<string, string>[],
    failStatus: null as number | null,
    expiresIn: options.expiresIn === undefined ? 7200 : options.expiresIn,
    delayMs: options.delayMs ?? 0,
  };
  server.use(
    http.post(tenant.tokenEndpoint, async ({ request }) => {
      const params = Object.fromEntries(new URLSearchParams(await request.clone().text()));
      const mine =
        kind === 'client_credentials'
          ? params['grant_type'] === 'client_credentials'
          : params['connection'] !== undefined;
      if (!mine) return undefined;
      const n = control.requests.push(params);
      if (control.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, control.delayMs));
      if (control.failStatus !== null)
        return HttpResponse.json({ error: 'server_error' }, { status: control.failStatus });
      const scope = options.omitScope === true ? undefined : (options.scope ?? params['scope']);
      return HttpResponse.json({
        access_token: `${kind === 'connection' ? 'conn' : 'cc'}-${n}`,
        token_type: 'Bearer',
        ...(control.expiresIn !== null && { expires_in: control.expiresIn }),
        ...(scope !== undefined && { scope }),
      });
    })
  );
  return control;
}

interface Kind {
  name: string;
  prefix: string;
  endpoint: 'client_credentials' | 'connection';
  call(scoped: RequestScopedMcpClient): Promise<{ accessToken: string; expiresAt: number }>;
}

const KINDS: Kind[] = [
  {
    name: 'client credentials',
    prefix: M2M_PREFIX,
    endpoint: 'client_credentials',
    call: (scoped) => scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' }),
  },
  {
    name: 'connection',
    prefix: TV_PREFIX,
    endpoint: 'connection',
    call: (scoped) => scoped.getTokenForConnection({ connection: 'github' }),
  },
];

describe.each(KINDS)('token cache: $name tokens', (kind) => {
  it('serves the second identical call from the store, under its own namespace', async () => {
    const endpoint = useEndpoint(kind.endpoint);
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const first = await kind.call(scoped);
    const second = await kind.call(scoped);

    expect(endpoint.requests).toHaveLength(1);
    expect(second).toEqual(first);
    expect(store.keys(kind.prefix)).toHaveLength(1);
    expect(store.keys('a0.obo.')).toHaveLength(0);
    expect(store.entries.size).toBe(1);
  });

  it('requests a token on every call when no store is configured', async () => {
    const endpoint = useEndpoint(kind.endpoint);
    const scoped = await scopedFor(makeClient());

    await kind.call(scoped);
    await kind.call(scoped);

    expect(endpoint.requests).toHaveLength(2);
  });

  it('treats a store that throws on read as a miss, and says so once without leaking anything', async () => {
    const endpoint = useEndpoint(kind.endpoint);
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));
    await kind.call(scoped);
    const [storedKey] = [...store.entries.keys()];
    store.failGet = true;

    const second = await kind.call(scoped);
    const third = await kind.call(scoped);

    expect(second.accessToken).toMatch(/^(?:cc|conn)-2$/);
    expect(third.accessToken).toEqual(expect.any(String));
    expect(endpoint.requests).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain('STORE-SECRET');
    expect(logged()).not.toContain(storedKey);
    expect(logged()).not.toMatch(/(?:cc|conn)-\d/);
  });

  it('returns the token when the store throws on write, and says so once without leaking anything', async () => {
    const endpoint = useEndpoint(kind.endpoint);
    const store = new RecordingStore();
    store.failSet = true;
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const first = await kind.call(scoped);
    const second = await kind.call(scoped);

    expect(first.accessToken).toMatch(/^(?:cc|conn)-1$/);
    expect(second.accessToken).toMatch(/^(?:cc|conn)-2$/);
    expect(endpoint.requests).toHaveLength(2);
    expect(store.entries.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain('STORE-SECRET');
    expect(logged()).not.toMatch(/(?:cc|conn)-\d/);
    expect(logged()).not.toContain(kind.prefix);
  });

  const POISON: Array<[string, (good: CachedToken) => unknown]> = [
    ['a string', () => 'POISON'],
    ['null', () => null],
    ['an entry without grantedScopes', (g) => ({ accessToken: 'POISON', expiresAt: g.expiresAt })],
    ['an entry without accessToken', (g) => ({ expiresAt: g.expiresAt, grantedScopes: [] })],
    ['an entry with an empty accessToken', (g) => ({ ...g, accessToken: '' })],
    ['an entry with a numeric accessToken', (g) => ({ ...g, accessToken: 7 })],
    ['an entry with a NaN expiry', (g) => ({ ...g, accessToken: 'POISON', expiresAt: Number.NaN })],
    ['an entry with an infinite expiry', (g) => ({ ...g, accessToken: 'POISON', expiresAt: Number.POSITIVE_INFINITY })],
    ['an entry with a string expiry', (g) => ({ ...g, accessToken: 'POISON', expiresAt: '99999999999' })],
    ['an entry whose grantedScopes is a string', (g) => ({ ...g, accessToken: 'POISON', grantedScopes: 'a' })],
    ['an entry whose grantedScopes holds a number', (g) => ({ ...g, accessToken: 'POISON', grantedScopes: ['a', 1] })],
    ['an entry with a numeric scope', (g) => ({ ...g, accessToken: 'POISON', scope: 1 })],
    ['an entry with a numeric tokenType', (g) => ({ ...g, accessToken: 'POISON', tokenType: 1 })],
    ['an entry whose fields are inherited', (g) => Object.create({ ...g, accessToken: 'POISON' })],
    [
      'an entry whose property throws when read',
      (g) =>
        Object.defineProperty({ ...g }, 'accessToken', {
          enumerable: true,
          get() {
            throw new Error('getter');
          },
        }),
    ],
  ];

  it.each(POISON)('treats %s as a miss', async (_label, poison) => {
    const endpoint = useEndpoint(kind.endpoint);
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));
    await kind.call(scoped);
    const [storedKey] = [...store.entries.keys()];
    store.entries.set(storedKey!, poison(store.entries.get(storedKey!) as CachedToken));

    const result = await kind.call(scoped);

    expect(endpoint.requests).toHaveLength(2);
    expect(result.accessToken).not.toBe('POISON');
    expect(result.accessToken).toMatch(/^(?:cc|conn)-2$/);
  });

  it('does not store, and does not return, a token that expires within five seconds', async () => {
    const endpoint = useEndpoint(kind.endpoint, { expiresIn: 4 });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    await expect(kind.call(scoped)).rejects.toThrow('The token operation failed.');

    expect(endpoint.requests).toHaveLength(1);
    expect(store.sets).toBe(0);
    expect(store.entries.size).toBe(0);
  });

  it('does not store a token that came back without an expiry', async () => {
    useEndpoint(kind.endpoint, { expiresIn: null });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    await expect(kind.call(scoped)).rejects.toThrow('The token operation failed.');

    expect(store.sets).toBe(0);
  });

  it('does not store a token that is exactly at the five second margin, and stores one second more', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / 1000) * 1000);
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));
    useEndpoint(kind.endpoint, { expiresIn: 5 });
    await expect(kind.call(scoped)).rejects.toThrow('The token operation failed.');
    expect(store.sets).toBe(0);

    server.resetHandlers(...tenant.handlers);
    useEndpoint(kind.endpoint, { expiresIn: 6 });
    await expect(kind.call(scoped)).resolves.toBeDefined();
    expect(store.sets).toBe(1);
  });

  it('collapses concurrent identical calls into one request and gives each caller its own copy', async () => {
    const endpoint = useEndpoint(kind.endpoint, { delayMs: 40 });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const results = await Promise.all(Array.from({ length: 5 }, () => kind.call(scoped)));

    expect(endpoint.requests).toHaveLength(1);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
    expect(new Set(results).size).toBe(5);
    expect(store.sets).toBe(1);
  });

  it('does not remember a failure shared by concurrent callers', async () => {
    const endpoint = useEndpoint(kind.endpoint, { delayMs: 40 });
    endpoint.failStatus = 500;
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => kind.call(scoped)));

    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(endpoint.requests).toHaveLength(1);
    expect(store.entries.size).toBe(0);

    endpoint.failStatus = null;
    await expect(kind.call(scoped)).resolves.toMatchObject({ accessToken: expect.stringMatching(/^(?:cc|conn)-2$/) });
    expect(endpoint.requests).toHaveLength(2);
  });

  it('round trips through the encrypted store, which keeps the token out of the clear', async () => {
    const endpoint = useEndpoint(kind.endpoint);
    const inner = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: createEncryptedTokenStore(inner, { secret: SECRET }) }));

    const first = await kind.call(scoped);
    const second = await kind.call(scoped);

    expect(endpoint.requests).toHaveLength(1);
    expect(second).toEqual(first);
    expect(inner.keys(kind.prefix)).toHaveLength(1);
    expect(JSON.stringify([...inner.entries.values()])).not.toContain(first.accessToken);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads an entry written under another secret as a miss', async () => {
    const endpoint = useEndpoint(kind.endpoint);
    const inner = new RecordingStore();
    const one = await scopedFor(makeClient({ tokenStore: createEncryptedTokenStore(inner, { secret: SECRET }) }));
    await kind.call(one);
    const other = await scopedFor(
      makeClient({ tokenStore: createEncryptedTokenStore(inner, { secret: `${SECRET}-rotated` }) })
    );

    await kind.call(other);

    expect(endpoint.requests).toHaveLength(2);
  });

  it('caches nothing and shares no request when the client is built from a pre-built apiClient', async () => {
    const endpoint = useEndpoint(kind.endpoint, { delayMs: 30 });
    const store = new RecordingStore();
    const client = createMcpClient({
      domain: 'tenant.example.com',
      audience: AUDIENCE,
      tokenStore: store,
      apiClient: new ApiClient({
        domain: 'tenant.example.com',
        audience: AUDIENCE,
        clientId: 'mcp-client',
        clientSecret: 'secret',
      }),
    });
    const scoped = await scopedFor(client);

    await kind.call(scoped);
    await kind.call(scoped);
    await Promise.all([kind.call(scoped), kind.call(scoped), kind.call(scoped)]);

    expect(endpoint.requests).toHaveLength(5);
    expect(store.gets).toBe(0);
    expect(store.sets).toBe(0);
  });

  it('keeps entries of one client apart from another client sharing the store', async () => {
    const endpoint = useEndpoint(kind.endpoint);
    const store = new RecordingStore();
    const one = await scopedFor(makeClient({ tokenStore: store, clientId: 'client-one' }));
    const two = await scopedFor(makeClient({ tokenStore: store, clientId: 'client-two' }));

    await kind.call(one);
    await kind.call(two);
    await kind.call(one);
    await kind.call(two);

    expect(endpoint.requests).toHaveLength(2);
    expect(store.keys(kind.prefix)).toHaveLength(2);
  });

  it('does not let a store that edits what it is given change the result', async () => {
    useEndpoint(kind.endpoint);
    const store = new RecordingStore();
    store.onSet = (value) => {
      value.accessToken = 'TAMPERED';
      value.grantedScopes.push('evil');
    };
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const first = await kind.call(scoped);

    expect(first.accessToken).not.toBe('TAMPERED');
    expect((first as { grantedScopes?: string[] }).grantedScopes ?? []).not.toContain('evil');
  });
});

describe('token cache: client credentials', () => {
  /** `null` leaves the scope out of the request. */
  const call = (scoped: RequestScopedMcpClient, scope: string | null = 'a', audience = DOWNSTREAM) =>
    scoped.getClientCredentialsToken({ audience, ...(scope !== null && { scope }) });

  it('returns the whole result on a hit, including scope and token type', async () => {
    useEndpoint('client_credentials', { scope: 'b a' });
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    const first = await call(scoped, 'a b');
    const second = await call(scoped, 'a b');

    expect(first).toMatchObject({ scope: 'b a', tokenType: 'bearer', grantedScopes: ['a', 'b'] });
    expect(second).toEqual(first);
  });

  it('misses for another audience', async () => {
    const endpoint = useEndpoint('client_credentials');
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    await call(scoped, 'a', DOWNSTREAM);
    await call(scoped, 'a', 'https://other.example.com/resource');

    expect(endpoint.requests).toHaveLength(2);
  });

  it('misses for another scope', async () => {
    const endpoint = useEndpoint('client_credentials');
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    await call(scoped, 'a');
    await call(scoped, 'a b');
    await call(scoped, 'b');

    expect(endpoint.requests).toHaveLength(3);
  });

  it('treats the same scope set written differently as one request', async () => {
    const endpoint = useEndpoint('client_credentials');
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    await call(scoped, 'b a');
    await call(scoped, '  a   b a ');

    expect(endpoint.requests).toHaveLength(1);
  });

  it('shares one token between callers, because the credentials belong to the server', async () => {
    const endpoint = useEndpoint('client_credentials');
    const client = makeClient({ tokenStore: new RecordingStore() });
    const alice = await scopedFor(client, 'user|alice');
    const bob = await scopedFor(client, 'user|bob');

    const a = await call(alice);
    const b = await call(bob);

    expect(endpoint.requests).toHaveLength(1);
    expect(b.accessToken).toBe(a.accessToken);
  });

  it('caches a request without scope apart from one with scope, and never lets an empty scope reach the cache', async () => {
    const endpoint = useEndpoint('client_credentials');
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const without = await call(scoped, null);
    await expect(call(scoped, '')).rejects.toBeInstanceOf(InvalidScopeError);
    await expect(call(scoped, '   ')).rejects.toBeInstanceOf(InvalidScopeError);
    const withScope = await call(scoped, 'a');
    const withoutAgain = await call(scoped, null);

    expect(withScope.accessToken).not.toBe(without.accessToken);
    expect(withoutAgain.accessToken).toBe(without.accessToken);
    expect(endpoint.requests).toHaveLength(2);
    expect(store.keys(M2M_PREFIX)).toHaveLength(2);
  });

  it('keeps a request without scope from being answered by a request with an empty scope', async () => {
    useEndpoint('client_credentials');
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));
    await call(scoped, null);

    await expect(call(scoped, '')).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it('stores what was granted when the response has no scope field, and serves it back', async () => {
    useEndpoint('client_credentials', { omitScope: true });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const first = await call(scoped, 'b a');
    const second = await call(scoped, 'b a');

    expect(first.grantedScopes).toEqual(['a', 'b']);
    expect(second.grantedScopes).toEqual(['a', 'b']);
    expect(second).not.toHaveProperty('scope');
  });

  it('refuses a narrowed grant on every call and never stores it', async () => {
    const endpoint = useEndpoint('client_credentials', { scope: 'a' });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const first = await call(scoped, 'a b').catch((e: unknown) => e);
    const second = await call(scoped, 'a b').catch((e: unknown) => e);

    expect((first as Error).cause).toBeInstanceOf(DownscopedTokenError);
    expect((second as Error).cause).toBeInstanceOf(DownscopedTokenError);
    expect(endpoint.requests).toHaveLength(2);
    expect(store.sets).toBe(0);
  });

  it('refuses an empty grant when scopes were requested, and does not store it', async () => {
    useEndpoint('client_credentials', { scope: '' });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    const err = await call(scoped, 'a').catch((e: unknown) => e);

    expect((err as Error).cause).toBeInstanceOf(DownscopedTokenError);
    expect(store.sets).toBe(0);
  });

  it('stores and serves a grant that is wider than the request', async () => {
    const endpoint = useEndpoint('client_credentials', { scope: 'a b c' });
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    const first = await call(scoped, 'a');
    const second = await call(scoped, 'a');

    expect(second.grantedScopes).toEqual(['a', 'b', 'c']);
    expect(second).toEqual(first);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('does not serve a stored entry whose grant does not cover the request', async () => {
    const endpoint = useEndpoint('client_credentials');
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));
    await call(scoped, 'a');
    const [storedKey] = [...store.entries.keys()];
    store.entries.set(storedKey!, {
      ...(store.entries.get(storedKey!) as CachedToken),
      accessToken: 'NARROW',
      grantedScopes: ['x'],
    });

    const result = await call(scoped, 'a');

    expect(result.accessToken).not.toBe('NARROW');
    expect(endpoint.requests).toHaveLength(2);
  });

  it('serves a stored entry for a request without scope whatever it was granted', async () => {
    const endpoint = useEndpoint('client_credentials', { scope: 'x y' });
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    await call(scoped, null);
    const second = await call(scoped, null);

    expect(second.grantedScopes).toEqual(['x', 'y']);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('gives every hit its own grantedScopes array', async () => {
    useEndpoint('client_credentials');
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));
    await call(scoped);

    const hit = await call(scoped);
    hit.grantedScopes.push('evil');
    hit.accessToken = 'changed';

    const [stored] = [...store.entries.values()] as CachedToken[];
    expect(stored!.grantedScopes).toEqual(['a']);
    expect(stored!.accessToken).not.toBe('changed');
    expect((await call(scoped)).grantedScopes).toEqual(['a']);
  });

  it('gives concurrent callers their own grantedScopes array', async () => {
    useEndpoint('client_credentials', { delayMs: 30 });
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    const [one, two] = await Promise.all([call(scoped), call(scoped)]);
    one!.grantedScopes.push('evil');

    expect(two!.grantedScopes).toEqual(['a']);
  });

  it('does not let concurrent calls for different scopes or audiences share a request', async () => {
    const endpoint = useEndpoint('client_credentials', { delayMs: 30 });
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    const results = await Promise.all([
      call(scoped, 'a'),
      call(scoped, 'b'),
      call(scoped, 'a', 'https://other.example.com/resource'),
      call(scoped, null),
    ]);

    expect(endpoint.requests).toHaveLength(4);
    expect(results.map((r) => r.grantedScopes)).toEqual([['a'], ['b'], ['a'], []]);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(4);
  });

  it('serves an entry up to the five second margin as a miss and one second beyond it as a hit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const nowSeconds = Math.floor(Date.now() / 1000);
    vi.setSystemTime(nowSeconds * 1000);
    const endpoint = useEndpoint('client_credentials');
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));
    await call(scoped);
    const [storedKey] = [...store.entries.keys()];
    const good = store.entries.get(storedKey!) as CachedToken;

    store.entries.set(storedKey!, { ...good, expiresAt: nowSeconds + 5 });
    await call(scoped);
    expect(endpoint.requests).toHaveLength(2);

    store.entries.set(storedKey!, { ...good, expiresAt: nowSeconds + 6 });
    await call(scoped);
    expect(endpoint.requests).toHaveLength(2);
  });
});

describe('token cache: connection tokens', () => {
  const call = (scoped: RequestScopedMcpClient, connection = 'github', loginHint?: string) =>
    scoped.getTokenForConnection({ connection, ...(loginHint !== undefined && { loginHint }) });

  it('misses for another subject and never hands one caller the token of another', async () => {
    const endpoint = useEndpoint('connection');
    const client = makeClient({ tokenStore: new RecordingStore() });
    const alice = await scopedFor(client, 'user|alice', { sid: 's1' });
    const bob = await scopedFor(client, 'user|bob', { sid: 's1' });

    const a = await call(alice);
    const b = await call(bob);
    const aAgain = await call(alice);

    expect(b.accessToken).not.toBe(a.accessToken);
    expect(aAgain.accessToken).toBe(a.accessToken);
    expect(endpoint.requests).toHaveLength(2);
    expect(endpoint.requests[0]!['subject_token']).not.toBe(endpoint.requests[1]!['subject_token']);
  });

  it('misses for another connection', async () => {
    const endpoint = useEndpoint('connection');
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    await call(scoped, 'github');
    await call(scoped, 'google-oauth2');
    await call(scoped, 'github');

    expect(endpoint.requests).toHaveLength(2);
  });

  it('keeps an absent login hint, an empty one and a given one apart, without folding case', async () => {
    const endpoint = useEndpoint('connection');
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    const absent = await call(scoped, 'github', undefined);
    const empty = await call(scoped, 'github', '');
    const octo = await call(scoped, 'github', 'octo');
    const upper = await call(scoped, 'github', 'OCTO');
    expect(endpoint.requests).toHaveLength(4);

    expect((await call(scoped, 'github', undefined)).accessToken).toBe(absent.accessToken);
    expect((await call(scoped, 'github', '')).accessToken).toBe(empty.accessToken);
    expect((await call(scoped, 'github', 'octo')).accessToken).toBe(octo.accessToken);
    expect((await call(scoped, 'github', 'OCTO')).accessToken).toBe(upper.accessToken);
    expect(endpoint.requests).toHaveLength(4);
    expect(new Set([absent, empty, octo, upper].map((r) => r.accessToken)).size).toBe(4);
  });

  it('misses for another organization', async () => {
    const endpoint = useEndpoint('connection');
    const client = makeClient({ tokenStore: new RecordingStore() });
    const one = await scopedFor(client, 'user|1', { sid: 's1', org_id: 'org_one' });
    const two = await scopedFor(client, 'user|1', { sid: 's1', org_id: 'org_two' });
    const none = await scopedFor(client, 'user|1', { sid: 's1' });

    await call(one);
    await call(two);
    await call(none);
    await call(one);

    expect(endpoint.requests).toHaveLength(3);
  });

  it('misses for another client of the caller', async () => {
    const endpoint = useEndpoint('connection');
    const client = makeClient({ tokenStore: new RecordingStore() });
    const one = await scopedFor(client, 'user|1', { sid: 's1', azp: 'app-one' });
    const two = await scopedFor(client, 'user|1', { sid: 's1', azp: 'app-two' });

    await call(one);
    await call(two);

    expect(endpoint.requests).toHaveLength(2);
  });

  it('misses for another session of the same user, and shares within one session', async () => {
    const endpoint = useEndpoint('connection');
    const client = makeClient({ tokenStore: new RecordingStore() });
    const first = await scopedFor(client, 'user|1', { sid: 's1', n: 1 });
    const sameSession = await scopedFor(client, 'user|1', { sid: 's1', n: 2 });
    const otherSession = await scopedFor(client, 'user|1', { sid: 's2', n: 3 });

    await call(first);
    await call(sameSession);
    expect(endpoint.requests).toHaveLength(1);

    await call(otherSession);
    expect(endpoint.requests).toHaveLength(2);
  });

  it('without sid or jti, separates different access tokens and shares one', async () => {
    const endpoint = useEndpoint('connection');
    const client = makeClient({ tokenStore: new RecordingStore() });
    const one = await caller(client, 'user|1', { n: 1 });
    const two = await caller(client, 'user|1', { n: 2 });

    await call(client.withToken(one));
    await call(client.withToken(one));
    expect(endpoint.requests).toHaveLength(1);

    await call(client.withToken(two));
    expect(endpoint.requests).toHaveLength(2);
  });

  it('uses jti as the session when there is no sid', async () => {
    const endpoint = useEndpoint('connection');
    const client = makeClient({ tokenStore: new RecordingStore() });

    await call(await scopedFor(client, 'user|1', { jti: 'j1', n: 1 }));
    await call(await scopedFor(client, 'user|1', { jti: 'j1', n: 2 }));
    expect(endpoint.requests).toHaveLength(1);

    await call(await scopedFor(client, 'user|1', { jti: 'j2', n: 3 }));
    expect(endpoint.requests).toHaveLength(2);
  });

  it('sends the caller token and the login hint, and builds connection and loginHint from the request on a hit', async () => {
    const endpoint = useEndpoint('connection', { scope: 'repo' });
    const client = makeClient({ tokenStore: new RecordingStore() });
    const scoped = await scopedFor(client);

    const first = await call(scoped, 'github', 'octo');
    const second = await call(scoped, 'github', 'octo');
    const noHint = await call(scoped, 'github');

    expect(endpoint.requests[0]).toMatchObject({ connection: 'github', login_hint: 'octo' });
    expect(second).toEqual(first);
    expect(second).toMatchObject({ connection: 'github', loginHint: 'octo', scope: 'repo' });
    expect(noHint.loginHint).toBeUndefined();
    expect(noHint).not.toHaveProperty('loginHint', 'octo');
  });

  it('takes connection and loginHint from the request even if the stored entry claims others', async () => {
    useEndpoint('connection');
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));
    await call(scoped);
    const [storedKey] = [...store.entries.keys()];
    store.entries.set(storedKey!, {
      ...(store.entries.get(storedKey!) as CachedToken),
      connection: 'evil',
      loginHint: 'evil',
    });

    const hit = await call(scoped);

    expect(hit.connection).toBe('github');
    expect(hit.loginHint).toBeUndefined();
  });

  it('stores what the provider granted as normalized scopes and returns the scope string as issued', async () => {
    useEndpoint('connection', { scope: 'b  a' });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    await call(scoped);
    const hit = await call(scoped);

    const [stored] = [...store.entries.values()] as CachedToken[];
    expect(stored!.grantedScopes).toEqual(['a', 'b']);
    expect(hit.scope).toBe('b  a');
  });

  it('serves a token without a scope', async () => {
    const endpoint = useEndpoint('connection', { omitScope: true });
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    await call(scoped);
    const hit = await call(scoped);

    const [stored] = [...store.entries.values()] as CachedToken[];
    expect(stored!.grantedScopes).toEqual([]);
    expect(hit.scope).toBeUndefined();
    expect(endpoint.requests).toHaveLength(1);
  });

  it('gives concurrent callers their own result objects', async () => {
    useEndpoint('connection', { delayMs: 30 });
    const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));

    const [one, two] = await Promise.all([call(scoped), call(scoped)]);
    one!.accessToken = 'changed';

    expect(two!.accessToken).not.toBe('changed');
  });

  it('does not let concurrent calls for different connections, login hints or subjects share a request', async () => {
    const endpoint = useEndpoint('connection', { delayMs: 30 });
    const client = makeClient({ tokenStore: new RecordingStore() });
    const alice = await scopedFor(client, 'user|alice', { sid: 's1' });
    const bob = await scopedFor(client, 'user|bob', { sid: 's1' });

    const results = await Promise.all([
      call(alice, 'github'),
      call(alice, 'google-oauth2'),
      call(alice, 'github', 'octo'),
      call(bob, 'github'),
    ]);

    expect(endpoint.requests).toHaveLength(4);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(4);
    expect(results.map((r) => r.connection)).toEqual(['github', 'google-oauth2', 'github', 'github']);
  });

  describe('a caller whose own token is about to expire', () => {
    /** Warms the cache with a caller whose token expires at a known second, then moves the clock. */
    async function warmed() {
      vi.useFakeTimers({ toFake: ['Date'] });
      const t0 = Math.floor(Date.now() / 1000);
      vi.setSystemTime(t0 * 1000);
      const endpoint = useEndpoint('connection', { expiresIn: 100000 });
      const scoped = await scopedFor(makeClient({ tokenStore: new RecordingStore() }));
      await call(scoped);
      return { endpoint, scoped, exp: t0 + 3600 };
    }

    it('is refused on a hit once its token has expired, without a request', async () => {
      const { endpoint, scoped, exp } = await warmed();
      vi.setSystemTime((exp + 1) * 1000);

      await expect(call(scoped)).rejects.toBeInstanceOf(UnauthenticatedError);

      expect(endpoint.requests).toHaveLength(1);
    });

    it('is refused inside the last five seconds, and served six seconds before the end', async () => {
      const { endpoint, scoped, exp } = await warmed();

      vi.setSystemTime((exp - 6) * 1000);
      await expect(call(scoped)).resolves.toBeDefined();

      vi.setSystemTime((exp - 5) * 1000);
      await expect(call(scoped)).rejects.toBeInstanceOf(UnauthenticatedError);
      vi.setSystemTime((exp - 1) * 1000);
      await expect(call(scoped)).rejects.toBeInstanceOf(UnauthenticatedError);

      expect(endpoint.requests).toHaveLength(1);
    });

    it('is refused as a 401 error that carries a generic message', async () => {
      const { scoped, exp } = await warmed();
      vi.setSystemTime(exp * 1000);

      const err = (await call(scoped).catch((e: unknown) => e)) as UnauthenticatedError;

      expect(err).toBeInstanceOf(UnauthenticatedError);
      expect(err.statusCode).toBe(401);
    });
  });
});

describe('token cache: connection tokens, caller expiry from either source', () => {
  const IDENTITY: ExchangeIdentity = {
    tenant: 'tenant.example.com',
    clientId: 'mcp-client',
    audience: AUDIENCE,
    layout: 'strict',
  };

  function stubbed(options: { principalExpiresIn: number; claims: Record<string, unknown>; store?: RecordingStore }) {
    const now = Math.floor(Date.now() / 1000);
    const state = { requests: 0 };
    const apiClient = {
      async getAccessTokenForConnection(): Promise<unknown> {
        const n = ++state.requests;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { accessToken: `t${n}`, scope: undefined, expiresAt: now + 100000, connection: 'github' };
      },
    } as unknown as ApiClient;
    const principal: Principal = {
      sub: 'user|1',
      expiresAt: now + options.principalExpiresIn,
      scopes: [],
      permissions: null,
      clientId: null,
      orgId: null,
    };
    const store = options.store ?? new RecordingStore();
    const verified: VerifiedToken = {
      accessToken: 'caller-token',
      claims: { sub: 'user|1', ...options.claims } as VerifiedToken['claims'],
    };
    const scoped = createRequestScopedClient({
      apiClient,
      tokenStore: store,
      principal,
      verified,
      exchanges: new SingleFlight(),
      exchangeIdentity: IDENTITY,
      tokenCache: createTokenCache({ store, tenant: 'tenant.example.com', clientId: 'mcp-client' }),
    });
    return { scoped, state, store };
  }

  it('serves a hit while both the principal and the exp claim are far from expiry (control)', async () => {
    const { scoped, state } = stubbed({
      principalExpiresIn: 3600,
      claims: { exp: Math.floor(Date.now() / 1000) + 3600 },
    });

    await scoped.getTokenForConnection({ connection: 'github' });
    await scoped.getTokenForConnection({ connection: 'github' });

    expect(state.requests).toBe(1);
  });

  it('refuses a hit when only the exp claim is near expiry', async () => {
    const store = new RecordingStore();
    const seeded = stubbed({ principalExpiresIn: 3600, claims: { exp: Math.floor(Date.now() / 1000) + 3600 }, store });
    await seeded.scoped.getTokenForConnection({ connection: 'github' });
    const near = stubbed({ principalExpiresIn: 3600, claims: { exp: Math.floor(Date.now() / 1000) + 3 }, store });

    await expect(near.scoped.getTokenForConnection({ connection: 'github' })).rejects.toBeInstanceOf(
      UnauthenticatedError
    );

    expect(near.state.requests).toBe(0);
  });

  it('refuses a hit when only the principal is near expiry', async () => {
    const store = new RecordingStore();
    const seeded = stubbed({ principalExpiresIn: 3600, claims: { exp: Math.floor(Date.now() / 1000) + 3600 }, store });
    await seeded.scoped.getTokenForConnection({ connection: 'github' });
    const near = stubbed({ principalExpiresIn: 3, claims: { exp: Math.floor(Date.now() / 1000) + 3600 }, store });

    await expect(near.scoped.getTokenForConnection({ connection: 'github' })).rejects.toBeInstanceOf(
      UnauthenticatedError
    );

    expect(near.state.requests).toBe(0);
  });

  it('refuses a caller that joins a request of the same session while its own token is about to expire', async () => {
    const store = new RecordingStore();
    const leader = stubbed({
      principalExpiresIn: 3600,
      claims: { sid: 's1', exp: Math.floor(Date.now() / 1000) + 3600 },
      store,
    });
    const waiter = stubbed({
      principalExpiresIn: 3,
      claims: { sid: 's1', exp: Math.floor(Date.now() / 1000) + 3 },
      store,
    });

    const settled = await Promise.allSettled([
      leader.scoped.getTokenForConnection({ connection: 'github' }),
      waiter.scoped.getTokenForConnection({ connection: 'github' }),
    ]);

    expect(settled[0]!.status).toBe('fulfilled');
    expect(settled[1]!.status).toBe('rejected');
  });

  it.each(KEYED_CLAIMS)(
    'does not cache or share a request for a caller whose %s claim is not a string',
    async (claim) => {
      const store = new RecordingStore();
      const { scoped, state } = stubbed({
        principalExpiresIn: 3600,
        claims: { iss: 'https://tenant.example.com/', sid: 's1', [claim]: 5 },
        store,
      });

      await scoped.getTokenForConnection({ connection: 'github' });
      await scoped.getTokenForConnection({ connection: 'github' });
      await Promise.all([
        scoped.getTokenForConnection({ connection: 'github' }),
        scoped.getTokenForConnection({ connection: 'github' }),
      ]);

      expect(state.requests).toBe(4);
      expect(store.gets).toBe(0);
      expect(store.sets).toBe(0);
    }
  );

  it('caches and shares for the same caller when every keyed claim is a string (control)', async () => {
    const store = new RecordingStore();
    const { scoped, state } = stubbed({
      principalExpiresIn: 3600,
      claims: { iss: 'https://tenant.example.com/', sid: 's1' },
      store,
    });

    await Promise.all([
      scoped.getTokenForConnection({ connection: 'github' }),
      scoped.getTokenForConnection({ connection: 'github' }),
    ]);
    await scoped.getTokenForConnection({ connection: 'github' });

    expect(state.requests).toBe(1);
  });
});

describe('token cache: the store as a whole', () => {
  it('keeps On Behalf Of, client credentials and connection entries in separate namespaces that do not disturb each other', async () => {
    const endpoint = useEndpoint('connection');
    const cc = useEndpoint('client_credentials');
    const store = new RecordingStore();
    const scoped = await scopedFor(makeClient({ tokenStore: store }));

    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'a' });
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' });
    await scoped.getTokenForConnection({ connection: 'github' });
    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'a' });
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' });
    await scoped.getTokenForConnection({ connection: 'github' });

    expect(store.keys('a0.obo.')).toHaveLength(1);
    expect(store.keys(M2M_PREFIX)).toHaveLength(1);
    expect(store.keys(TV_PREFIX)).toHaveLength(1);
    expect(store.entries.size).toBe(3);
    expect(endpoint.requests).toHaveLength(1);
    expect(cc.requests).toHaveLength(1);
    expect(tenant.state.exchangeCount).toBe(1);
  });
});

describe('token cache keys', () => {
  const store = new RecordingStore();
  const make = (tenantName = 'tenant.example.com', clientId = 'client') =>
    createTokenCache({ store, tenant: tenantName, clientId })!;
  const verified = (claims: Record<string, unknown> = {}, accessToken = 'token-1'): VerifiedToken => ({
    accessToken,
    claims: {
      iss: 'https://tenant.example.com/',
      client_id: 'caller-app',
      sub: 'user|1',
      org_id: 'org_1',
      sid: 's1',
      ...claims,
    } as VerifiedToken['claims'],
  });

  it('is undefined without a store, without a client id and without a tenant', () => {
    expect(createTokenCache({ store: undefined, tenant: 'tenant.example.com', clientId: 'client' })).toBeUndefined();
    expect(createTokenCache({ store, tenant: 'tenant.example.com', clientId: undefined })).toBeUndefined();
    expect(createTokenCache({ store, tenant: 'tenant.example.com', clientId: '' })).toBeUndefined();
    expect(createTokenCache({ store, tenant: '', clientId: 'client' })).toBeUndefined();
  });

  it('builds client credentials keys in their own namespace that depend on every input', async () => {
    const base = (await make().clientCredentialsKey(DOWNSTREAM, 'a'))!;
    expect(base).toMatch(/^a0\.mcp\.m2m\.v1\.[A-Za-z0-9_-]{43}$/);
    expect(await make().clientCredentialsKey(DOWNSTREAM, 'a')).toBe(base);

    const others = [
      await make('other.example.com').clientCredentialsKey(DOWNSTREAM, 'a'),
      await make('tenant.example.com', 'other-client').clientCredentialsKey(DOWNSTREAM, 'a'),
      await make().clientCredentialsKey('https://other.example.com', 'a'),
      await make().clientCredentialsKey(DOWNSTREAM, 'b'),
      await make().clientCredentialsKey(DOWNSTREAM, undefined),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });

  it('normalizes the tenant and the scope set', async () => {
    const base = await make('tenant.example.com').clientCredentialsKey(DOWNSTREAM, 'a b');
    expect(await make('https://Tenant.Example.com').clientCredentialsKey(DOWNSTREAM, 'b  a a')).toBe(base);
  });

  it('has no key for a request core rejects: blank or non-string scope, empty audience', async () => {
    expect(await make().clientCredentialsKey(DOWNSTREAM, '')).toBeUndefined();
    expect(await make().clientCredentialsKey(DOWNSTREAM, ' \t ')).toBeUndefined();
    expect(await make().clientCredentialsKey(DOWNSTREAM, 5)).toBeUndefined();
    expect(await make().clientCredentialsKey(DOWNSTREAM, null)).toBeUndefined();
    expect(await make().clientCredentialsKey('', 'a')).toBeUndefined();
    expect(await make().clientCredentialsKey(undefined, 'a')).toBeUndefined();
  });

  it('cannot be made to collide by moving characters between fields', async () => {
    const one = await make('tenant.example.com', 'ab').clientCredentialsKey('c', undefined);
    const two = await make('tenant.example.com', 'a').clientCredentialsKey('bc', undefined);
    const three = await make('tenant.example.com', 'ab').clientCredentialsKey('c', 'd');
    const four = await make('tenant.example.com', 'ab').clientCredentialsKey('cd', undefined);
    expect(new Set([one, two, three, four]).size).toBe(4);
  });

  it('builds connection keys in their own namespace that depend on every input', async () => {
    const cache = make();
    const base = (await cache.connectionKey(verified(), 'github', undefined))!;
    expect(base).toMatch(/^a0\.mcp\.tv\.v1\.[A-Za-z0-9_-]{43}$/);
    expect(await make().connectionKey(verified(), 'github', undefined)).toBe(base);

    const others = [
      await make('other.example.com').connectionKey(verified(), 'github', undefined),
      await make('tenant.example.com', 'other-client').connectionKey(verified(), 'github', undefined),
      await cache.connectionKey(verified({ iss: 'https://other.example.com/' }), 'github', undefined),
      await cache.connectionKey(verified({ client_id: 'other-app' }), 'github', undefined),
      await cache.connectionKey(verified({ sub: 'user|2' }), 'github', undefined),
      await cache.connectionKey(verified({ org_id: 'org_2' }), 'github', undefined),
      await cache.connectionKey(verified({ org_id: undefined }), 'github', undefined),
      await cache.connectionKey(verified({ sid: 's2' }), 'github', undefined),
      await cache.connectionKey(verified({ sid: undefined, jti: 'j1' }), 'github', undefined),
      await cache.connectionKey(verified({ sid: undefined }, 'token-1'), 'github', undefined),
      await cache.connectionKey(verified({ sid: undefined }, 'token-2'), 'github', undefined),
      await cache.connectionKey(verified(), 'google', undefined),
      await cache.connectionKey(verified(), 'github', ''),
      await cache.connectionKey(verified(), 'github', 'octo'),
      await cache.connectionKey(verified(), 'github', 'OCTO'),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });

  it('reads the caller client from client_id before azp, like the core client', async () => {
    const cache = make();
    const both = await cache.connectionKey(verified({ client_id: 'x', azp: 'y' }), 'github', undefined);
    expect(await cache.connectionKey(verified({ client_id: 'x', azp: undefined }), 'github', undefined)).toBe(both);
    expect(await cache.connectionKey(verified({ client_id: undefined, azp: 'x' }), 'github', undefined)).toBe(both);
    expect(await cache.connectionKey(verified({ client_id: undefined, azp: 'y' }), 'github', undefined)).not.toBe(both);
  });

  it('treats an empty sid like an absent one, so the jti decides', async () => {
    const cache = make();
    const withJti = await cache.connectionKey(verified({ sid: undefined, jti: 'j1' }), 'github', undefined);
    expect(await cache.connectionKey(verified({ sid: '', jti: 'j1' }), 'github', undefined)).toBe(withJti);
    expect(await cache.connectionKey(verified({ sid: 's1', jti: 'j1' }), 'github', undefined)).not.toBe(withJti);
  });

  it('has no key for a caller with an unkeyable claim, a missing connection or a non-string login hint', async () => {
    const cache = make();
    expect(await cache.connectionKey(verified({ sub: 5 }), 'github', undefined)).toBeUndefined();
    expect(await cache.connectionKey(verified({ sid: ['s'] }), 'github', undefined)).toBeUndefined();
    expect(await cache.connectionKey(verified(), '', undefined)).toBeUndefined();
    expect(await cache.connectionKey(verified(), undefined, undefined)).toBeUndefined();
    expect(await cache.connectionKey(verified(), 'github', 5)).toBeUndefined();
  });

  it('cannot be made to collide by moving characters between connection and login hint', async () => {
    const cache = make();
    const one = await cache.connectionKey(verified(), 'ab', 'c');
    const two = await cache.connectionKey(verified(), 'a', 'bc');
    const three = await cache.connectionKey(verified(), 'abc', undefined);
    const four = await cache.connectionKey(verified(), 'abc', '');
    expect(new Set([one, two, three, four]).size).toBe(4);
  });
});
