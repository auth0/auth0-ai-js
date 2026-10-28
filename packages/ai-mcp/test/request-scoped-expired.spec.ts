import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { CachedToken, TokenStore } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import { createAuth0Handlers, createTestKey, mintAccessToken } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function scopedClient(expiresIn: number, tokenStore?: TokenStore) {
  tenant = createAuth0Handlers({ key, expiresIn });
  server.use(...tenant.handlers);
  const client = createMcpClient({
    domain: 'tenant.example.com',
    audience: AUDIENCE,
    clientId: 'mcp-client',
    clientSecret: 'secret',
    ...(tokenStore !== undefined && { tokenStore }),
  });
  const accessToken = await mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: 'user|1', scope: 'openid' });
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
