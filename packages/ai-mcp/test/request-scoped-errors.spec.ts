import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { AuthError, TokenByClientCredentialsError, TokenExchangeError } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import type { McpClient } from '../src/client.js';
import { sanitizeTokenError } from '../src/request-scoped-client.js';
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';
const TOKEN_URL = 'https://tenant.example.com/oauth/token';

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): McpClient {
  return createMcpClient({
    domain: 'tenant.example.com',
    audience: AUDIENCE,
    clientId: 'mcp-client',
    clientSecret: 'secret',
  });
}

async function scoped(client: McpClient) {
  tenant = createAuth0Handlers({ key, scope: scopeMode.echo });
  server.use(...tenant.handlers);
  const accessToken = await mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: 'user|1',
    scope: 'openid',
    claims: { sid: 's1', jti: 't1' },
  });
  return client.withToken(await client.verifyAccessToken({ accessToken }));
}

/** Answers every token request with a rate limit response that carries a `Retry-After` header. */
function rateLimitTokenEndpoint() {
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json(
        { error: 'too_many_requests', error_description: 'upstream detail that must not leak' },
        { status: 429, headers: { 'Retry-After': '7' } }
      )
    )
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

type HttpFields = { code?: string; statusCode?: number; headers?: Headers; body?: string };

describe('request-scoped client: HTTP details on sanitized token endpoint errors', () => {
  it('keeps code, statusCode and Retry-After on a rate limited exchange', async () => {
    const c = await scoped(makeClient());
    rateLimitTokenEndpoint();

    const error = await rejection(c.getTokenOnBehalfOf({ audience: DOWNSTREAM }));
    const fields = error as Error & HttpFields;

    expect(error).toBeInstanceOf(TokenExchangeError);
    expect(error.message).toBe('The token operation failed.');
    expect(fields.code).toBe((error.cause as HttpFields).code);
    expect(fields.code).toEqual(expect.any(String));
    expect(fields.statusCode).toBe(429);
    expect(fields.headers?.get('retry-after')).toBe('7');
  });

  it('keeps code, statusCode and Retry-After on a rate limited client credentials grant', async () => {
    const c = await scoped(makeClient());
    rateLimitTokenEndpoint();

    const error = await rejection(c.getClientCredentialsToken({ audience: DOWNSTREAM }));
    const fields = error as Error & HttpFields;

    expect(error).toBeInstanceOf(TokenByClientCredentialsError);
    expect(error.message).toBe('The token operation failed.');
    expect(fields.code).toEqual(expect.any(String));
    expect(fields.statusCode).toBe(429);
    expect(fields.headers?.get('retry-after')).toBe('7');
  });

  it('keeps code, statusCode and Retry-After on a rate limited connection exchange', async () => {
    const c = await scoped(makeClient());
    rateLimitTokenEndpoint();

    const error = await rejection(c.getTokenForConnection({ connection: 'github' }));
    const fields = error as Error & HttpFields;

    expect(error.message).toBe('The token operation failed.');
    expect(fields.statusCode).toBe(429);
    expect(fields.headers?.get('retry-after')).toBe('7');
  });

  it('does not copy the response body and gives each error its own headers object', async () => {
    const c = await scoped(makeClient());
    rateLimitTokenEndpoint();

    const first = (await rejection(c.getTokenOnBehalfOf({ audience: DOWNSTREAM }))) as Error & HttpFields;
    const second = (await rejection(c.getTokenOnBehalfOf({ audience: DOWNSTREAM }))) as Error & HttpFields;

    expect(first.body).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain('upstream detail');
    expect(first.headers).not.toBe((first.cause as HttpFields).headers);
    expect(first.headers).not.toBe(second.headers);
  });

  it('leaves the fields unset when the error response carries none', async () => {
    const c = await scoped(makeClient());
    server.use(http.post(TOKEN_URL, () => HttpResponse.error()));

    const error = (await rejection(c.getTokenOnBehalfOf({ audience: DOWNSTREAM }))) as Error & HttpFields;

    expect(error.message).toBe('The token operation failed.');
    expect(error.statusCode).toBeUndefined();
    expect(error.headers).toBeUndefined();
  });
});

describe('sanitizeTokenError: HTTP details', () => {
  it('copies the headers of an AuthError one level deep, including list values', () => {
    const original = new AuthError('upstream detail', 'some_code', 502, { 'x-list': ['a', 'b'], 'x-one': 'c' });

    const safe = sanitizeTokenError(original) as AuthError;

    expect(safe).toBeInstanceOf(AuthError);
    expect(safe.message).toBe('The token operation failed.');
    expect(safe.code).toBe('some_code');
    expect(safe.statusCode).toBe(502);
    expect(safe.headers).toEqual({ 'x-list': ['a', 'b'], 'x-one': 'c' });
    expect(safe.headers).not.toBe(original.headers);
    (safe.headers!['x-list'] as string[]).push('tampered');
    expect(original.headers!['x-list']).toEqual(['a', 'b']);
  });

  it('keeps a string code, a finite status code and headers from a plain error', () => {
    const original = Object.assign(new Error('boom'), {
      code: 'ECONNRESET',
      statusCode: 503,
      headers: { 'retry-after': '3' },
    });

    const safe = sanitizeTokenError(original) as Error & HttpFields;

    expect(safe.message).toBe('The token operation failed.');
    expect(safe.code).toBe('ECONNRESET');
    expect(safe.statusCode).toBe(503);
    expect(safe.headers).toEqual({ 'retry-after': '3' });
  });

  it('never copies the response body', () => {
    const original = Object.assign(new Error('boom'), { code: 'x', statusCode: 400, body: 'upstream detail' });

    const safe = sanitizeTokenError(original) as Error & HttpFields;

    expect(safe.body).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('upstream detail');
  });

  it('ignores fields of the wrong type', () => {
    const original = Object.assign(new Error('boom'), {
      code: 23,
      statusCode: Number.NaN,
      headers: { 'x-bad': 5, 'x-mixed': ['a', 7] },
    });

    const safe = sanitizeTokenError(original) as Error & HttpFields;

    expect(safe.code).toBeUndefined();
    expect(safe.statusCode).toBeUndefined();
    expect(safe.headers).toEqual({});
  });

  it('does not read fields from a thrown value that is not an error', () => {
    const safe = sanitizeTokenError({ code: 'x', statusCode: 429 }) as Error & HttpFields;

    expect(safe.message).toBe('The token operation failed.');
    expect(safe.code).toBeUndefined();
    expect(safe.statusCode).toBeUndefined();
  });
});
