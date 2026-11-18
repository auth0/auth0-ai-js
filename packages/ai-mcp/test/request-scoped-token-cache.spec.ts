import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import {
  ApiClient,
  InvalidConfigurationError,
  InvalidRequestError,
  MissingClientAuthError,
  VerifyAccessTokenError,
} from '@auth0/auth0-api-js';
import type { CachedToken, TokenStore } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import type { McpClient, VerifiedCaller } from '../src/client.js';
import { UnauthenticatedError } from '../src/errors.js';
import { sanitizeTokenError } from '../src/request-scoped-client.js';
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from './support/index.js';
import type { TestKey } from './support/index.js';

const DOMAIN = 'tenant.example.com';
const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();
let warn: MockInstance<typeof console.warn>;
const logged = () => warn.mock.calls.map((call) => String(call[0])).join('\n');

/** The Token Vault requests the test tenant received, answered with a different token each time. */
let connectionRequests: Array<Record<string, string>> = [];

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
});
beforeEach(() => {
  connectionRequests = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function useTenant(options: Parameters<typeof createAuth0Handlers>[0] extends infer O ? Partial<O> : never = {}) {
  tenant = createAuth0Handlers({ key, ...options });
  server.use(
    http.post(tenant.tokenEndpoint, async ({ request }) => {
      const params = Object.fromEntries(new URLSearchParams(await request.clone().text()));
      if (!params['requested_token_type']) return undefined;
      connectionRequests.push(params);
      return HttpResponse.json({
        access_token: `connection-token-${connectionRequests.length}`,
        expires_in: 3600,
        scope: 'repo',
        token_type: 'Bearer',
      });
    }),
    ...tenant.handlers
  );
}

class Store implements TokenStore {
  readonly entries = new Map<string, CachedToken>();
  async get(k: string) {
    return this.entries.get(k);
  }
  async set(k: string, v: CachedToken) {
    this.entries.set(k, v);
  }
  async delete(k: string) {
    this.entries.delete(k);
  }
}

function makeClient(extra: Partial<Parameters<typeof createMcpClient>[0]> = {}): McpClient {
  return createMcpClient({
    domain: DOMAIN,
    audience: AUDIENCE,
    clientId: 'mcp-client',
    clientSecret: 'secret',
    ...extra,
  });
}

function subjectToken(sub: string, claims: Record<string, unknown> = {}, expiresIn = 3600) {
  return mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub, scope: 'openid', claims, expiresIn });
}

async function caller(client: McpClient, sub = 'user|1', claims: Record<string, unknown> = {}, expiresIn = 3600): Promise<VerifiedCaller> {
  return client.verifyAccessToken({ accessToken: await subjectToken(sub, claims, expiresIn) });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

describe('client credentials through the core cache (T-6)', () => {
  it('makes one token request for two identical calls and a second for a different audience or scope', async () => {
    useTenant();
    const store = new Store();
    const client = makeClient({ tokenStore: store });
    const scoped = client.withToken(await caller(client));

    const first = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a b' });
    const second = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'b a' });
    expect(tenant.state.clientCredentialsCount).toBe(1);
    expect(second).toEqual(first);

    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' });
    expect(tenant.state.clientCredentialsCount).toBe(2);
    await scoped.getClientCredentialsToken({ audience: `${DOWNSTREAM}/other`, scope: 'a b' });
    expect(tenant.state.clientCredentialsCount).toBe(3);
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    expect(tenant.state.clientCredentialsCount).toBe(4);

    expect(store.entries.size).toBe(4);
    for (const storeKey of store.entries.keys()) expect(storeKey).toMatch(/^a0\.m2m\.v1\.[\w-]{43}$/);
  });

  it('is shared by callers, because the grant belongs to the server', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new Store() });
    const alice = client.withToken(await caller(client, 'user|alice'));
    const bob = client.withToken(await caller(client, 'user|bob'));

    await alice.getClientCredentialsToken({ audience: DOWNSTREAM });
    await bob.getClientCredentialsToken({ audience: DOWNSTREAM });

    expect(tenant.state.clientCredentialsCount).toBe(1);
  });

  it('does not share entries between clients with different client ids on one store', async () => {
    useTenant();
    const store = new Store();
    const one = makeClient({ tokenStore: store, clientId: 'client-one' });
    const two = makeClient({ tokenStore: store, clientId: 'client-two' });

    await one.withToken(await caller(one)).getClientCredentialsToken({ audience: DOWNSTREAM });
    await two.withToken(await caller(two)).getClientCredentialsToken({ audience: DOWNSTREAM });

    expect(tenant.state.clientCredentialsCount).toBe(2);
    expect(store.entries.size).toBe(2);
  });

  it('shares one request between concurrent identical calls, and not between different scopes', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new Store() });
    const scoped = client.withToken(await caller(client));

    const same = await Promise.all([
      scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' }),
      scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' }),
      scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' }),
    ]);
    expect(tenant.state.clientCredentialsCount).toBe(1);
    // Each caller gets its own copy.
    expect(same[0]).not.toBe(same[1]);
    expect(same[0]!.grantedScopes).not.toBe(same[1]!.grantedScopes);

    await Promise.all([
      scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'b' }),
      scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'c' }),
    ]);
    expect(tenant.state.clientCredentialsCount).toBe(3);
  });

  it('serves a token with 31 seconds left from the store, the margin core uses', async () => {
    useTenant({ expiresIn: 31 });
    const client = makeClient({ tokenStore: new Store() });
    const scoped = client.withToken(await caller(client));
    // A fixed clock after the caller token exists, so both calls see the same second.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());

    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });

    expect(tenant.state.clientCredentialsCount).toBe(1);
  });

  it('never caches a token with less than 30 seconds left, and rejects it', async () => {
    useTenant({ expiresIn: 20 });
    const store = new Store();
    const client = makeClient({ tokenStore: store });
    const scoped = client.withToken(await caller(client));

    expect((await failure(scoped.getClientCredentialsToken({ audience: DOWNSTREAM }))).message).toBe(
      'The token operation failed.'
    );
    expect(store.entries.size).toBe(0);
  });
});

describe('Token Vault through the core cache (T-7)', () => {
  it('makes one request for two identical calls of one caller', async () => {
    useTenant();
    const store = new Store();
    const client = makeClient({ tokenStore: store });
    const scoped = client.withToken(await caller(client));

    const first = await scoped.getTokenForConnection({ connection: 'github' });
    const second = await scoped.getTokenForConnection({ connection: 'github' });

    expect(connectionRequests).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first.accessToken).toBe('connection-token-1');
    expect([...store.entries.keys()]).toEqual([expect.stringMatching(/^a0\.tv\.v1\.[\w-]{43}$/)]);
  });

  it('keeps another connection, another login hint and another caller apart', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new Store() });
    const alice = client.withToken(await caller(client, 'user|alice'));
    const bob = client.withToken(await caller(client, 'user|bob'));

    await alice.getTokenForConnection({ connection: 'github' });
    await alice.getTokenForConnection({ connection: 'slack' });
    await alice.getTokenForConnection({ connection: 'github', loginHint: 'octo' });
    expect(connectionRequests).toHaveLength(3);

    const bobToken = await bob.getTokenForConnection({ connection: 'github' });
    expect(connectionRequests).toHaveLength(4);
    expect(bobToken.accessToken).toBe('connection-token-4');

    // And each is then served from the store.
    await alice.getTokenForConnection({ connection: 'github' });
    await bob.getTokenForConnection({ connection: 'github' });
    expect(connectionRequests).toHaveLength(4);
  });

  it('does not serve one session\'s token to another session of the same user', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new Store() });
    const one = client.withToken(await caller(client, 'user|1', { sid: 'session-1' }));
    const two = client.withToken(await caller(client, 'user|1', { sid: 'session-2' }));
    const oneAgain = client.withToken(await caller(client, 'user|1', { sid: 'session-1' }));

    await one.getTokenForConnection({ connection: 'github' });
    await two.getTokenForConnection({ connection: 'github' });
    expect(connectionRequests).toHaveLength(2);
    await oneAgain.getTokenForConnection({ connection: 'github' });
    expect(connectionRequests).toHaveLength(2);
  });

  it('shares one request between concurrent identical calls of one caller only', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new Store() });
    const alice = client.withToken(await caller(client, 'user|alice'));
    const bob = client.withToken(await caller(client, 'user|bob'));

    const results = await Promise.all([
      alice.getTokenForConnection({ connection: 'github' }),
      alice.getTokenForConnection({ connection: 'github' }),
      bob.getTokenForConnection({ connection: 'github' }),
    ]);

    expect(connectionRequests).toHaveLength(2);
    expect(results[0]!.accessToken).toBe(results[1]!.accessToken);
    expect(results[2]!.accessToken).not.toBe(results[0]!.accessToken);
  });
});

describe('concurrent Token Vault requests that differ', () => {
  it('are not shared across connections or login hints', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new Store() });
    const scoped = client.withToken(await caller(client));

    const results = await Promise.all([
      scoped.getTokenForConnection({ connection: 'github' }),
      scoped.getTokenForConnection({ connection: 'slack' }),
      scoped.getTokenForConnection({ connection: 'github', loginHint: 'octo' }),
    ]);

    expect(connectionRequests).toHaveLength(3);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(3);
  });
});

describe('without a token store (T-8)', () => {
  it('goes to the tenant on every call', async () => {
    useTenant();
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    await scoped.getTokenForConnection({ connection: 'github' });
    await scoped.getTokenForConnection({ connection: 'github' });

    expect(tenant.state.clientCredentialsCount).toBe(2);
    expect(connectionRequests).toHaveLength(2);
  });

  it('does not share concurrent calls either', async () => {
    useTenant();
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    await Promise.all([
      scoped.getClientCredentialsToken({ audience: DOWNSTREAM }),
      scoped.getClientCredentialsToken({ audience: DOWNSTREAM }),
    ]);

    expect(tenant.state.clientCredentialsCount).toBe(2);
  });
});

describe('error contract with the cache (T-9)', () => {
  it('refuses Token Vault for a caller token that has expired, before any request and without serving a hit', async () => {
    useTenant();
    const store = new Store();
    const client = makeClient({ tokenStore: store });
    const verified = await caller(client, 'user|1', {}, 3600);
    const scoped = client.withToken(verified);
    await scoped.getTokenForConnection({ connection: 'github' });
    expect(connectionRequests).toHaveLength(1);

    // A caller token with 20 seconds left is inside the margin: the cached entry is not served.
    const soon = client.withToken(await caller(client, 'user|1', {}, 20));
    const error = await failure(soon.getTokenForConnection({ connection: 'github' }));

    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect(connectionRequests).toHaveLength(1);
  });

  it('rejects a narrowed client credentials grant and does not store it', async () => {
    useTenant({ scope: scopeMode.fixed('a') });
    const store = new Store();
    const client = makeClient({ tokenStore: store });
    const scoped = client.withToken(await caller(client));

    for (let call = 1; call <= 2; call++) {
      const error = await failure(scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a b' }));
      expect(error.message).toBe('The token operation failed.');
      expect(tenant.state.clientCredentialsCount).toBe(call);
    }
    expect(store.entries.size).toBe(0);
  });

  it('serves a grant that covers the request and rejects a later wider request', async () => {
    useTenant({ scope: scopeMode.fixed('a b') });
    const client = makeClient({ tokenStore: new Store() });
    const scoped = client.withToken(await caller(client));

    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' });
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' });
    expect(tenant.state.clientCredentialsCount).toBe(1);

    expect((await failure(scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a c' }))).message).toBe(
      'The token operation failed.'
    );
  });

  it('returns the token when the store throws on every call, and reports each kind once without any key or token', async () => {
    useTenant();
    const broken: TokenStore = {
      get: async () => {
        throw new Error('secret-store-detail');
      },
      set: async () => {
        throw new Error('secret-store-detail');
      },
      delete: async () => {
        throw new Error('secret-store-detail');
      },
    };
    const client = makeClient({ tokenStore: broken });
    const scoped = client.withToken(await caller(client));

    const one = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    const two = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    const connection = await scoped.getTokenForConnection({ connection: 'github' });
    await scoped.getTokenForConnection({ connection: 'github' });

    expect(one.accessToken).toBeTruthy();
    expect(two.accessToken).toBeTruthy();
    expect(connection.accessToken).toBe('connection-token-1');
    expect(tenant.state.clientCredentialsCount).toBe(2);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => /failed on a read/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /failed on a write/.test(line))).toHaveLength(1);
    expect(logged()).not.toContain('secret-store-detail');
    expect(logged()).not.toMatch(/a0\.(m2m|tv)\.v1/);
    expect(logged()).not.toContain(one.accessToken);
    expect(logged()).not.toContain('connection-token');
  });

  it('reports a failing store once per client, not once for all', async () => {
    useTenant();
    const broken: TokenStore = {
      get: async () => {
        throw new Error('x');
      },
      set: async () => {},
      delete: async () => {},
    };
    for (const client of [makeClient({ tokenStore: broken }), makeClient({ tokenStore: broken })]) {
      const scoped = client.withToken(await caller(client));
      await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
      await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    }
    expect(warn.mock.calls.filter((call) => /failed on a read/.test(String(call[0])))).toHaveLength(2);
  });

  it('writes nothing to the console when the store works', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new Store() });
    const scoped = client.withToken(await caller(client));
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    await scoped.getTokenForConnection({ connection: 'github' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails a client without credentials before it reads or writes the store', async () => {
    useTenant();
    const store = new Store();
    const get = vi.spyOn(store, 'get');
    const set = vi.spyOn(store, 'set');
    const client = makeClient({ tokenStore: store, clientSecret: undefined });
    const scoped = client.withToken(await caller(client));

    const cc = await failure(scoped.getClientCredentialsToken({ audience: DOWNSTREAM }));
    const tv = await failure(scoped.getTokenForConnection({ connection: 'github' }));

    for (const error of [cc, tv]) {
      expect(error).toBeInstanceOf(MissingClientAuthError);
      expect(error.message).toBe('The token operation failed.');
    }
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(tenant.state.clientCredentialsCount).toBe(0);
    expect(connectionRequests).toHaveLength(0);
  });

  it.each([
    ['MissingClientAuthError', new MissingClientAuthError()],
    ['InvalidRequestError', new InvalidRequestError('secret-detail')],
    ['InvalidConfigurationError', new InvalidConfigurationError('secret-detail')],
  ])('turns a store path %s into a generic error of the same class that keeps the original as cause', (name, original) => {
    const safe = sanitizeTokenError(original);
    expect(safe).not.toBe(original);
    expect(safe.constructor).toBe(original.constructor);
    expect(safe.name).toBe(name);
    expect(safe.message).toBe('The token operation failed.');
    expect(safe.cause).toBe(original);
    expect(JSON.stringify(safe)).not.toContain('secret-detail');
  });

  it('turns a VerifyAccessTokenError of the store path into a 401 that holds no detail', () => {
    const original = new VerifyAccessTokenError('secret-detail');
    const safe = sanitizeTokenError(original);
    expect(safe).toBeInstanceOf(UnauthenticatedError);
    expect(safe.cause).toBe(original);
    expect(safe.message).not.toContain('secret-detail');
  });

  it('never stores a token the store could return as an On Behalf Of entry', async () => {
    useTenant();
    const store = new Store();
    const client = makeClient({ tokenStore: store });
    const scoped = client.withToken(await caller(client));

    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    await scoped.getTokenForConnection({ connection: 'github' });
    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });

    const prefixes = [...store.entries.keys()].map((k) => k.split('.').slice(0, 3).join('.')).sort();
    expect(prefixes).toEqual(['a0.m2m.v1', 'a0.obo.v1', 'a0.tv.v1']);
  });
});

describe('a pre-built core client (T-11)', () => {
  it('follows the store: its own client id keys the cache and two clients do not share', async () => {
    useTenant();
    const store = new Store();
    const build = (clientId: string) =>
      createMcpClient({
        domain: DOMAIN,
        audience: AUDIENCE,
        tokenStore: store,
        apiClient: new ApiClient({ domain: DOMAIN, audience: AUDIENCE, clientId, clientSecret: 'secret' }),
      });
    const one = build('client-one');
    const two = build('client-two');
    const scopedOne = one.withToken(await caller(one));
    const scopedTwo = two.withToken(await caller(two));

    await scopedOne.getClientCredentialsToken({ audience: DOWNSTREAM });
    await scopedOne.getClientCredentialsToken({ audience: DOWNSTREAM });
    expect(tenant.state.clientCredentialsCount).toBe(1);
    await scopedTwo.getClientCredentialsToken({ audience: DOWNSTREAM });
    expect(tenant.state.clientCredentialsCount).toBe(2);

    await scopedOne.getTokenForConnection({ connection: 'github' });
    await scopedOne.getTokenForConnection({ connection: 'github' });
    await scopedTwo.getTokenForConnection({ connection: 'github' });
    expect(connectionRequests).toHaveLength(2);
  });

  it('adds no telemetry and still goes to the tenant on every call without a store', async () => {
    useTenant();
    const client = createMcpClient({
      domain: DOMAIN,
      audience: AUDIENCE,
      apiClient: new ApiClient({ domain: DOMAIN, audience: AUDIENCE, clientId: 'c', clientSecret: 's' }),
    });
    const scoped = client.withToken(await caller(client));
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    expect(tenant.state.clientCredentialsCount).toBe(2);
  });
});
