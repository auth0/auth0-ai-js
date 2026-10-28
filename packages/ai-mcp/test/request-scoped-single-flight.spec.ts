import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import type { CachedToken } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import type { McpClient, VerifiedCaller } from '../src/client.js';
import { DownscopedTokenError } from '../src/errors.js';
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';
const OTHER_DOWNSTREAM = 'https://other.example.com/resource';

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function useTenant(scope = scopeMode.echo) {
  tenant = createAuth0Handlers({ key, scope });
  server.use(...tenant.handlers);
}

class TestStore {
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
    domain: 'tenant.example.com',
    audience: AUDIENCE,
    clientId: 'mcp-client',
    clientSecret: 'secret',
    ...extra,
  });
}

/** Claims shared by default so each test varies exactly one thing. */
const SESSION = { sid: 'session-1', jti: 'token-1' };

function verify(client: McpClient, sub = 'user|1', claims: Record<string, unknown> = {}): Promise<VerifiedCaller> {
  return mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub,
    scope: 'openid',
    claims: { ...SESSION, ...claims },
  }).then((accessToken) => client.verifyAccessToken({ accessToken }));
}

async function scoped(client: McpClient, sub?: string, claims?: Record<string, unknown>) {
  return client.withToken(await verify(client, sub, claims));
}

describe('single flight on getTokenOnBehalfOf', () => {
  it('collapses 10 concurrent identical requests into one exchange', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }))
    );

    expect(tenant.state.exchangeCount).toBe(1);
    expect(tenant.state.successfulExchangeCount).toBe(1);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
  });

  it('shares one exchange across request-scoped clients of the same client', async () => {
    useTenant();
    const client = makeClient();
    const clients = await Promise.all(Array.from({ length: 10 }, () => scoped(client)));

    await Promise.all(clients.map((c) => c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' })));

    expect(tenant.state.exchangeCount).toBe(1);
  });

  it('shares one exchange when a store is configured and still fills the cache', async () => {
    useTenant();
    const store = new TestStore();
    const client = makeClient({ tokenStore: store });
    const c = await scoped(client);

    await Promise.all(Array.from({ length: 10 }, () => c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' })));
    await c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(tenant.state.exchangeCount).toBe(1);
    expect(store.entries.size).toBe(1);
  });

  it('treats the order and repetition of scopes as the same request', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);

    await Promise.all([
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' }),
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'write:a read:a' }),
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: ' write:a  read:a read:a ' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(1);
  });

  it('keeps requests for different audiences apart', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);

    const [a, b] = await Promise.all([
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      c.getTokenOnBehalfOf({ audience: OTHER_DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
    expect(a.accessToken).not.toBe(b.accessToken);
  });

  it('keeps requests for different scopes apart', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);

    const [a, b] = await Promise.all([
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:b' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
    expect(a.grantedScopes).toEqual(['read:a']);
    expect(b.grantedScopes).toEqual(['read:b']);
  });

  it('keeps a request with no scope apart from one with scopes', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);

    await Promise.all([
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM }),
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('keeps different subjects apart even within the same session id', async () => {
    useTenant();
    const client = makeClient();
    const alice = await scoped(client, 'user|alice');
    const bob = await scoped(client, 'user|bob');

    const [a, b] = await Promise.all([
      alice.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      bob.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
    expect(a.accessToken).not.toBe(b.accessToken);
  });

  it('keeps different session ids apart even for the same subject and token id', async () => {
    useTenant();
    const client = makeClient();
    const first = await scoped(client, 'user|1', { sid: 'session-A' });
    const second = await scoped(client, 'user|1', { sid: 'session-B' });

    await Promise.all([
      first.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      second.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('shares an exchange across different tokens of one session', async () => {
    useTenant();
    const client = makeClient();
    const first = await scoped(client, 'user|1', { jti: 'token-A' });
    const second = await scoped(client, 'user|1', { jti: 'token-B' });

    await Promise.all([
      first.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      second.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(1);
  });

  it('keeps different organizations apart', async () => {
    useTenant();
    const client = makeClient();
    const one = await scoped(client, 'user|1', { org_id: 'org_1' });
    const two = await scoped(client, 'user|1', { org_id: 'org_2' });

    await Promise.all([
      one.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      two.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('keeps different tokens apart when the token carries no session id or token id', async () => {
    useTenant();
    const client = makeClient();
    const bare = { sid: undefined, jti: undefined };
    const first = await scoped(client, 'user|1', { ...bare, extra: 1 });
    const second = await scoped(client, 'user|1', { ...bare, extra: 2 });

    await Promise.all([
      first.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      second.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('does not exchange a token with a non-string keyed claim together with another caller', async () => {
    useTenant();
    const client = makeClient();
    const odd = await scoped(client, 'user|1', { sid: 42 });
    const plain = await scoped(client, 'user|1');

    await Promise.all([
      odd.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      plain.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('does not share exchanges between separate clients', async () => {
    useTenant();
    const one = await scoped(makeClient());
    const two = await scoped(makeClient());

    await Promise.all([
      one.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      two.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('rejects every waiter when the exchange fails, and does not remember the failure', async () => {
    useTenant();
    tenant.state.failure = { status: 400, body: { error: 'invalid_grant' } };
    tenant.state.failureDelayMs = 50;
    const client = makeClient();
    const c = await scoped(client);

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }))
    );

    expect(settled.map((r) => r.status)).toEqual(Array(5).fill('rejected'));
    expect(tenant.state.exchangeCount).toBe(1);

    tenant.state.failure = null;
    const retry = await c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(retry.accessToken).toEqual(expect.any(String));
    expect(tenant.state.exchangeCount).toBe(2);
    expect(tenant.state.successfulExchangeCount).toBe(1);
  });

  it('keeps no in-flight entry after a success', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);

    await c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });
    await c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('runs the scope check for every waiter after the shared exchange', async () => {
    useTenant(scopeMode.fixed('read:a'));
    const client = makeClient();
    const c = await scoped(client);

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' }))
    );

    expect(tenant.state.exchangeCount).toBe(1);
    expect(settled.every((r) => r.status === 'rejected' && r.reason instanceof DownscopedTokenError)).toBe(true);
  });

  it('gives each waiter its own result object', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);

    const [first, second] = await Promise.all([
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);
    first.grantedScopes.push('tampered');

    expect(tenant.state.exchangeCount).toBe(1);
    expect(second.grantedScopes).toEqual(['read:a']);
  });
});
