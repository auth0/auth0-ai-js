import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { AuthError, InvalidRequestError, MissingClientAuthError, VerifyAccessTokenError } from '@auth0/auth0-api-js';
import type { CachedToken } from '@auth0/auth0-api-js';
import { sanitizeTokenError } from '../src/request-scoped-client.js';
import { createMcpClient } from '../src/client.js';
import { createMcpHandler } from '../src/handler.js';
import { getCallerMcpClientOrThrow } from '../src/index.js';
import type { McpClient, VerifiedCaller } from '../src/client.js';
import { DownscopedTokenError, InsufficientScopeError, UnauthenticatedError } from '../src/errors.js';
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';
const GENERIC = 'The token operation failed.';
const LEAK = 'LEAKY-UPSTREAM-DETAIL-4711';

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

class MapStore {
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

async function caller(client: McpClient, expiresIn = 3600): Promise<VerifiedCaller> {
  const accessToken = await mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: 'user|1',
    scope: 'openid',
    expiresIn,
  });
  return client.verifyAccessToken({ accessToken });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

function expectSanitized(error: Error) {
  expect(error.message).toBe(GENERIC);
  expect(error.message).not.toContain(LEAK);
  expect(error.cause).toBeDefined();
}

describe('request-scoped client: error hygiene', () => {
  it.each([400, 401, 403, 500])('replaces the message of a failed exchange (%i)', async (status) => {
    useTenant();
    tenant.state.failure = {
      status,
      body: { error: 'invalid_grant', error_description: LEAK },
    };
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const error = await rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));

    expectSanitized(error);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('keeps the original error as the cause', async () => {
    useTenant();
    tenant.state.failure = {
      status: 400,
      body: { error: 'invalid_grant', error_description: LEAK },
    };
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const error = await rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));

    expect(error.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(error.message)).not.toContain(LEAK);
  });

  it('reports caller claims too close to expiry as UnauthenticatedError without leaking the message', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new MapStore() });
    const scoped = client.withToken(await caller(client, 2));

    const error = await rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));

    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect(error.message).not.toContain('expired');
    expect(error.cause).toBeInstanceOf(VerifyAccessTokenError);
    expect(tenant.state.exchangeCount).toBe(0);
  });

  it('hides the message of a network failure and keeps the cause', async () => {
    useTenant();
    server.use(http.post(tenant.tokenEndpoint, () => HttpResponse.error()));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const error = await rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));

    expectSanitized(error);
  });

  it('keeps the class of a core configuration error', async () => {
    useTenant();
    const client = makeClient({ clientSecret: undefined });
    const scoped = client.withToken(await caller(client));

    const error = await rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));

    expect(error).toBeInstanceOf(MissingClientAuthError);
    expect(error.name).toBe('MissingClientAuthError');
    expectSanitized(error);
  });

  it('keeps code, status and headers when sanitizing a core AuthError', () => {
    const original = new InvalidRequestError(LEAK, { 'www-authenticate': 'Bearer realm="x"' });

    const safe = sanitizeTokenError(original) as AuthError;

    expect(safe).not.toBe(original);
    expect(safe).toBeInstanceOf(InvalidRequestError);
    expect(safe.name).toBe(original.name);
    expect(safe.code).toBe(original.code);
    expect(safe.statusCode).toBe(original.statusCode);
    expect(safe.headers).toEqual(original.headers);
    expect(safe.cause).toBe(original);
    expect(safe.message).toBe(GENERIC);
  });

  it('copies headers, so the sanitized error shares no object with the original or another copy', () => {
    const original = new AuthError(LEAK, 'invalid_request', 400, {
      'www-authenticate': 'Bearer realm="x"',
      'x-multi': ['a', 'b'],
    });

    const first = sanitizeTokenError(original) as AuthError;
    const second = sanitizeTokenError(original) as AuthError;

    expect(first.headers).toEqual(original.headers);
    expect(first.headers).not.toBe(original.headers);
    expect(first.headers).not.toBe(second.headers);
    expect(first.headers?.['x-multi']).not.toBe(original.headers?.['x-multi']);
    (first.headers?.['x-multi'] as string[]).push('c');
    expect(original.headers?.['x-multi']).toEqual(['a', 'b']);
  });

  it('does not copy a foreign prototype onto the sanitized error', () => {
    let ran = false;
    class Foreign extends Error {
      get leak() {
        ran = true;
        return LEAK;
      }
    }
    class ForeignAuth extends AuthError {
      get leak() {
        ran = true;
        return LEAK;
      }
    }

    const plain = sanitizeTokenError(new Foreign(LEAK));
    const auth = sanitizeTokenError(new ForeignAuth(LEAK, 'x', 418)) as AuthError;

    expect(plain).not.toBeInstanceOf(Foreign);
    expect(auth).not.toBeInstanceOf(ForeignAuth);
    expect(auth).toBeInstanceOf(AuthError);
    expect(auth.code).toBe('x');
    expect(auth.statusCode).toBe(418);
    expect((plain as unknown as { leak?: string }).leak).toBeUndefined();
    expect((auth as unknown as { leak?: string }).leak).toBeUndefined();
    expect(ran).toBe(false);
    expect(plain.message).toBe(GENERIC);
    expect(auth.message).toBe(GENERIC);
  });

  it('wraps a non-Error value without losing it', () => {
    const safe = sanitizeTokenError(LEAK);

    expect(safe.message).toBe(GENERIC);
    expect(safe.cause).toBe(LEAK);
  });

  it('returns each package error unchanged', () => {
    for (const original of [
      new DownscopedTokenError(),
      new InsufficientScopeError(['a']),
      new UnauthenticatedError(),
    ]) {
      expect(sanitizeTokenError(original)).toBe(original);
    }
  });

  it('hides the message of a failed client credentials grant', async () => {
    useTenant();
    tenant.state.failure = {
      status: 401,
      grant: 'client_credentials',
      body: { error: 'access_denied', error_description: LEAK },
    };
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    expectSanitized(await rejection(scoped.getClientCredentialsToken({ audience: DOWNSTREAM })));
  });

  it('hides the message of a failed connection exchange', async () => {
    useTenant();
    server.use(
      http.post(tenant.tokenEndpoint, async ({ request }) => {
        const params = Object.fromEntries(new URLSearchParams(await request.text()));
        if (!params['requested_token_type']) return undefined;
        return HttpResponse.json({ error: 'access_denied', error_description: LEAK }, { status: 403 });
      })
    );
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    expectSanitized(await rejection(scoped.getTokenForConnection({ connection: 'github' })));
  });

  it('gives every concurrent waiter its own sanitized error', async () => {
    useTenant();
    tenant.state.failure = {
      status: 400,
      body: { error: 'invalid_grant', error_description: LEAK },
    };
    tenant.state.failureDelayMs = 50;
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const errors = await Promise.all(
      Array.from({ length: 4 }, () => rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM })))
    );

    expect(tenant.state.exchangeCount).toBe(1);
    errors.forEach(expectSanitized);
    expect(new Set(errors).size).toBe(4);
    expect(new Set(errors.map((e) => e.cause)).size).toBe(1);
  });
});

describe('request-scoped client: package errors', () => {
  it('reports a caller token that expired during the request as UnauthenticatedError', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new MapStore() });
    const scoped = client.withToken(await caller(client));
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3600 * 1000);
    try {
      const error = await rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM }));

      expect(error).toBeInstanceOf(UnauthenticatedError);
      expect((error as UnauthenticatedError).statusCode).toBe(401);
      expect((error as UnauthenticatedError).code).toBe('invalid_token');
      expect(error.message).toBe(new UnauthenticatedError().message);
      expect(error.cause).toBeInstanceOf(VerifyAccessTokenError);
      expect(tenant.state.exchangeCount).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes a narrowed exchange through as the same DownscopedTokenError, without a cause', async () => {
    useTenant(scopeMode.fixed('other:scope'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const error = await rejection(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }));

    expect(error).toBeInstanceOf(DownscopedTokenError);
    expect(error.message).toBe(new DownscopedTokenError().message);
    expect(error.cause).toBeUndefined();
  });

  it('fails a narrowed client credentials grant with a non-auth error that carries the downscope cause', async () => {
    useTenant(scopeMode.fixed('other:scope'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const error = await rejection(
      scoped.getClientCredentialsToken({
        audience: DOWNSTREAM,
        scope: 'read:a',
      })
    );

    expect(error).not.toBeInstanceOf(AuthError);
    expect(error).not.toBeInstanceOf(DownscopedTokenError);
    expect(error.message).toBe(GENERIC);
    expect(error.cause).toBeInstanceOf(DownscopedTokenError);
  });

  it('answers a generic 500 without a scope challenge when a handler hits a narrowed client credentials grant', async () => {
    useTenant(scopeMode.fixed('other:scope'));
    const client = makeClient();
    const onError = vi.fn();
    const handle = createMcpHandler({
      client,
      resource: AUDIENCE,
      authorizationServers: [tenant.issuer],
      onError,
      handler: async () => {
        await getCallerMcpClientOrThrow().getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'read:a' });
        return new Response('ok');
      },
    });
    const accessToken = await mintAccessToken(key, {
      iss: tenant.issuer,
      aud: AUDIENCE,
      sub: 'user|1',
      scope: 'openid',
    });

    const response = await handle(
      new Request(`${AUDIENCE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } })
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'server_error', error_description: 'Internal server error.' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).cause).toBeInstanceOf(DownscopedTokenError);
  });
});
