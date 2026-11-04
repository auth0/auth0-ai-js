import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { CachedToken, TokenStore } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import { UnauthenticatedError } from '../src/errors.js';
import { createAuth0Handlers, createTestKey, mintAccessToken } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

/** Keeps the package's diagnostic lines out of the test output and lets tests read them. */
let warn: MockInstance<typeof console.warn>;
const logged = () => warn.mock.calls.map((call) => String(call[0])).join('\n');

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
});
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  server.resetHandlers();
  warn.mockRestore();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

async function scopedClient(expiresIn: number, tokenStore?: TokenStore, callerExpiresIn = 3600) {
  tenant = createAuth0Handlers({ key, expiresIn });
  server.use(...tenant.handlers);
  const client = createMcpClient({
    domain: 'tenant.example.com',
    audience: AUDIENCE,
    clientId: 'mcp-client',
    clientSecret: 'secret',
    ...(tokenStore !== undefined && { tokenStore }),
  });
  const accessToken = await mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: 'user|1',
    scope: 'openid',
    expiresIn: callerExpiresIn,
  });
  return client.withToken(await client.verifyAccessToken({ accessToken }));
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

/** The innermost `cause`, where the diagnostic of a rejected token response ends up. */
function rootCause(error: Error): Error {
  let current = error;
  while (current.cause instanceof Error) current = current.cause;
  return current;
}

describe('request-scoped client: already expired results', () => {
  it('rejects an already expired on-behalf-of token', async () => {
    const scoped = await scopedClient(0);
    const error = await failure(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));
    expect(error.message).toBe('The token operation failed.');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('does not serve an already expired on-behalf-of token from the store on the next call', async () => {
    const entries = new Map<string, CachedToken>();
    const store: TokenStore = {
      get: async (k) => entries.get(k),
      set: async (k, v) => void entries.set(k, v),
      delete: async (k) => void entries.delete(k),
    };
    const scoped = await scopedClient(0, store);
    await failure(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));
    await failure(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));
    expect(tenant.state.successfulExchangeCount).toBe(2);
  });

  it('rejects an already expired client credentials token', async () => {
    const scoped = await scopedClient(0);
    const error = await failure(scoped.getClientCredentialsToken({ audience: DOWNSTREAM }));
    expect(error.message).toBe('The token operation failed.');
  });

  it('rejects an already expired connection token', async () => {
    const scoped = await scopedClient(3600);
    server.use(
      http.post(tenant.tokenEndpoint, async ({ request }) => {
        const params = Object.fromEntries(new URLSearchParams(await request.text()));
        if (!params['requested_token_type']) return undefined;
        return HttpResponse.json({ access_token: 'connection-token', expires_in: 0, token_type: 'Bearer' });
      })
    );
    const error = await failure(scoped.getTokenForConnection({ connection: 'github' }));
    expect(error.message).toBe('The token operation failed.');
    expect(JSON.stringify(error)).not.toContain('connection-token');
  });

  it('still returns a token that is valid', async () => {
    const scoped = await scopedClient(3600);
    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('request-scoped client: a token response without an expiry', () => {
  /** Answers every token request with a token that has no `expires_in`. */
  function omitExpiry() {
    server.use(
      http.post(tenant.tokenEndpoint, () =>
        HttpResponse.json({ access_token: 'secret-token-value', token_type: 'Bearer', scope: 'read:a' })
      )
    );
  }

  function expectMissingExpiry(error: Error) {
    expect(error.message).toBe('The token operation failed.');
    expect(rootCause(error).message).toMatch(/without a usable expiry/);
    expect(rootCause(error).message).not.toMatch(/already expired/);
    expect(JSON.stringify(error)).not.toContain('secret-token-value');
  }

  it('reports a missing expiry on an on-behalf-of exchange, not an expired token', async () => {
    const scoped = await scopedClient(3600);
    omitExpiry();
    expectMissingExpiry(await failure(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM })));
  });

  it('reports a missing expiry on a client credentials grant', async () => {
    const scoped = await scopedClient(3600);
    omitExpiry();
    expectMissingExpiry(await failure(scoped.getClientCredentialsToken({ audience: DOWNSTREAM })));
  });

  it('reports a missing expiry on a connection token', async () => {
    const scoped = await scopedClient(3600);
    omitExpiry();
    expectMissingExpiry(await failure(scoped.getTokenForConnection({ connection: 'github' })));
  });

  it('keeps the expired cause for an expiry of zero', async () => {
    const scoped = await scopedClient(0);
    const error = await failure(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));
    expect(rootCause(error).message).toMatch(/already expired/);
  });
});

describe('request-scoped client: the caller token about to expire', () => {
  const memoryStore = (): TokenStore => {
    const entries = new Map<string, CachedToken>();
    return {
      get: async (k) => entries.get(k),
      set: async (k, v) => void entries.set(k, v),
      delete: async (k) => void entries.delete(k),
    };
  };

  it('becomes a 401 when a store is configured and the token has less than five seconds left', async () => {
    const scoped = await scopedClient(3600, memoryStore(), 3);
    const error = await failure(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));
    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect((error as UnauthenticatedError).statusCode).toBe(401);
    expect(tenant.state.exchangeCount).toBe(0);
  });

  it('is exchanged as usual when no store is configured', async () => {
    const scoped = await scopedClient(3600, undefined, 3);
    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });
    expect(result.accessToken).toBeTruthy();
    expect(tenant.state.exchangeCount).toBe(1);
  });
});

describe('request-scoped client: the expiry buffer', () => {
  type Operation = 'on_behalf_of' | 'client_credentials' | 'connection';

  /** Runs one operation, with the tenant issuing a token that expires in `expiresIn` seconds. */
  async function issue(operation: Operation, expiresIn: number) {
    const scoped = await scopedClient(expiresIn);
    // Fix the clock after the caller token exists, so `expires_in` maps to an exact second.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    if (operation === 'on_behalf_of') return scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });
    if (operation === 'client_credentials') return scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
    server.use(
      http.post(tenant.tokenEndpoint, async ({ request }) => {
        const params = Object.fromEntries(new URLSearchParams(await request.text()));
        if (!params['requested_token_type']) return undefined;
        return HttpResponse.json({ access_token: 'connection-token', expires_in: expiresIn, token_type: 'Bearer' });
      })
    );
    return scoped.getTokenForConnection({ connection: 'github' });
  }

  const operations: Operation[] = ['on_behalf_of', 'client_credentials', 'connection'];

  describe.each(operations)('%s', (operation) => {
    it.each([1, 4, 5])('rejects a token that expires in %i seconds', async (expiresIn) => {
      const error = await failure(issue(operation, expiresIn));
      expect(error.message).toBe('The token operation failed.');
      expect(rootCause(error).message).toMatch(/already expired or expires within 5 seconds/);
    });

    it('accepts a token that expires in 6 seconds', async () => {
      const result = await issue(operation, 6);
      expect(result.accessToken).toBeTruthy();
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs which operation produced an expired token, without any token data', async () => {
      await failure(issue(operation, 2));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logged()).toContain('[auth0-ai-mcp]');
      expect(logged()).toContain(`Operation: ${operation}.`);
      expect(logged()).toMatch(/expired or expires within 5 seconds/);
      expect(logged()).not.toContain('connection-token');
      expect(logged()).not.toContain(DOWNSTREAM);
    });
  });

  it('logs a missing expiry as such, not as an expired token', async () => {
    const scoped = await scopedClient(3600);
    server.use(
      http.post(tenant.tokenEndpoint, () =>
        HttpResponse.json({ access_token: 'secret-token-value', token_type: 'Bearer', scope: 'read:a' })
      )
    );
    await failure(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).toMatch(/without a usable expiry/);
    expect(logged()).not.toMatch(/already expired/);
    expect(logged()).toContain('Operation: on_behalf_of.');
    expect(logged()).not.toContain('secret-token-value');
  });

  it('logs nothing when the token is fine', async () => {
    const scoped = await scopedClient(3600);
    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });
    expect(warn).not.toHaveBeenCalled();
  });
});
