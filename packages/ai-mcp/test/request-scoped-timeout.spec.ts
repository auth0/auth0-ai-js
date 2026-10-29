import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpResponse, delay, http } from 'msw';
import { setupServer } from 'msw/node';
import { ApiClient, InvalidConfigurationError } from '@auth0/auth0-api-js';
import type { CachedToken } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import type { McpClient } from '../src/client.js';
import { UnauthenticatedError } from '../src/errors.js';
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';
const TOKEN_URL = 'https://tenant.example.com/oauth/token';
const TIMEOUT_MS = 150;

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class MapStore {
  readonly entries = new Map<string, CachedToken>();
  sets = 0;
  async get(k: string) {
    return this.entries.get(k);
  }
  async set(k: string, v: CachedToken) {
    this.sets++;
    this.entries.set(k, v);
  }
  async delete(k: string) {
    this.entries.delete(k);
  }
}

function useTenant() {
  tenant = createAuth0Handlers({ key, scope: scopeMode.echo });
  server.use(...tenant.handlers);
}

/** Makes the token endpoint hang until the request is aborted. Counts the calls it receives. */
function hangTokenEndpoint() {
  const state = { calls: 0 };
  server.use(
    http.post(TOKEN_URL, async () => {
      state.calls++;
      await delay('infinite');
      return HttpResponse.json({});
    })
  );
  return state;
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

async function scoped(client: McpClient) {
  const accessToken = await mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: 'user|1',
    scope: 'openid',
    claims: { sid: 's1', jti: 't1' },
  });
  return client.withToken(await client.verifyAccessToken({ accessToken }));
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('requestTimeoutMs', () => {
  it('fails a stalled exchange as a generic server error, not an authentication failure', async () => {
    useTenant();
    const hung = hangTokenEndpoint();
    const client = makeClient({ requestTimeoutMs: TIMEOUT_MS });
    const c = await scoped(client);

    const started = Date.now();
    const error = await rejection(c.getTokenOnBehalfOf({ audience: DOWNSTREAM }));

    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 10);
    expect(hung.calls).toBe(1);
    expect(error.message).toBe('The token operation failed.');
    expect(error).not.toBeInstanceOf(UnauthenticatedError);
    expect((error as { statusCode?: number }).statusCode).toBeUndefined();
  });

  it('rejects every waiter that shared the stalled exchange, then lets the next call retry', async () => {
    useTenant();
    const hung = hangTokenEndpoint();
    const store = new MapStore();
    const client = makeClient({ requestTimeoutMs: TIMEOUT_MS, tokenStore: store });
    const c = await scoped(client);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }))
    );

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(hung.calls).toBe(1);
    expect(store.sets).toBe(0);
    expect(store.entries.size).toBe(0);

    server.resetHandlers();
    useTenant();
    const recovered = await c.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(recovered.accessToken).toBeTruthy();
    expect(tenant.state.exchangeCount).toBe(1);
    expect(store.entries.size).toBe(1);
  });

  it('does not time out an exchange that answers in time', async () => {
    useTenant();
    server.use(
      http.post(TOKEN_URL, async () => {
        await delay(20);
        return undefined;
      })
    );
    const client = makeClient({ requestTimeoutMs: 5_000 });
    const c = await scoped(client);
    const result = await c.getTokenOnBehalfOf({ audience: DOWNSTREAM });
    expect(result.accessToken).toBeTruthy();
  });

  it('applies a default limit when none is set', async () => {
    useTenant();
    const client = makeClient();
    const c = await scoped(client);
    const result = await c.getTokenOnBehalfOf({ audience: DOWNSTREAM });
    expect(result.accessToken).toBeTruthy();
  });

  it.each([0, -5, Number.NaN, Infinity, 2_147_483_648, '100' as unknown as number])(
    'rejects an invalid value (%s) at construction',
    (requestTimeoutMs) => {
      expect(() => makeClient({ requestTimeoutMs })).toThrow(InvalidConfigurationError);
      expect(() => makeClient({ requestTimeoutMs })).toThrow(/requestTimeoutMs/);
    }
  );

  it('rejects the option together with a pre-built apiClient', () => {
    const apiClient = new ApiClient({ domain: 'tenant.example.com', audience: AUDIENCE });
    expect(() => createMcpClient({ domain: 'tenant.example.com', audience: AUDIENCE, apiClient, requestTimeoutMs: 100 })).toThrow(
      /requestTimeoutMs/
    );
  });
});
