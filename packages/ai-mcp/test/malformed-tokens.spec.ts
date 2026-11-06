import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { SignJWT } from 'jose';
import { AuthError } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import type { McpClient } from '../src/client.js';
import { createAuth0Handlers, createTestKey, mintAccessToken, mintUnsignedToken } from './support/index.js';
import type { TestKey } from './support/index.js';

const AUDIENCE = 'https://mcp.example.com';

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
let client: McpClient;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  tenant = createAuth0Handlers({ key });
  server.listen({ onUnhandledRequest: 'error' });
  client = createMcpClient({ domain: 'tenant.example.com', audience: AUDIENCE, clientId: 'c', clientSecret: 's' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function b64(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function mint(options: Parameters<typeof mintAccessToken>[1] = {}) {
  return mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: 'user|1', scope: 'openid', ...options });
}

async function verifyFailure(accessToken: string): Promise<unknown> {
  server.use(...tenant.handlers);
  try {
    await client.verifyAccessToken({ accessToken });
  } catch (error) {
    return error;
  }
  throw new Error('expected verification to fail');
}

describe('McpClient.verifyAccessToken: malformed and hostile tokens', () => {
  const now = () => Math.floor(Date.now() / 1000);

  const cases: Array<[string, () => Promise<string> | string]> = [
    ['an empty string', () => ''],
    ['whitespace only', () => '   '],
    ['a value that is not a JWT', () => 'not-a-jwt'],
    ['a token with two segments', () => `${b64('{"alg":"RS256"}')}.${b64('{}')}`],
    ['a token with four segments', () => 'a.b.c.d'],
    ['a token with invalid base64', () => '%%%.@@@.***'],
    ['a header that is not JSON', () => `${b64('not json')}.${b64('{}')}.sig`],
    ['a header that is a JSON array', () => `${b64('[]')}.${b64('{}')}.sig`],
    ['alg none', () => mintUnsignedToken({ iss: tenant.issuer, aud: AUDIENCE, sub: 'user|1', exp: now() + 3600 })],
    [
      'HS256 signed with the public key as the secret',
      () =>
        new SignJWT({ iss: tenant.issuer, aud: AUDIENCE, sub: 'user|1' })
          .setProtectedHeader({ alg: 'HS256', kid: key.kid })
          .setExpirationTime('1h')
          .sign(new TextEncoder().encode(JSON.stringify(key.publicJwk))),
    ],
    ['an unknown key id', () => mint({ header: { kid: 'no-such-key' } })],
    ['an expired token', () => mint({ exp: now() - 3600 })],
    ['a token that is not valid yet (nbf in the future)', () => mint({ claims: { nbf: now() + 3600 } })],
    ['a token without exp', () => mint({ exp: false })],
    ['a token for another audience', () => mint({ aud: 'https://other.example.com' })],
    ['a token from another issuer', () => mint({ iss: 'https://evil.example.com/' })],
  ];

  it.each(cases)('rejects %s with an authentication failure', async (_label, build) => {
    const error = await verifyFailure(await build());
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(401);
  });

  it('does not put the token in the error message', async () => {
    const token = await mint({ exp: now() - 3600 });
    const error = (await verifyFailure(token)) as Error;
    expect(error.message).not.toContain(token);
  });

  it('accepts a token whose nbf is in the past', async () => {
    server.use(...tenant.handlers);
    const caller = await client.verifyAccessToken({ accessToken: await mint({ claims: { nbf: now() - 60 } }) });
    expect(caller.principal.sub).toBe('user|1');
  });

  it('accepts a token with an empty scope claim and gives it no scopes', async () => {
    server.use(...tenant.handlers);
    const caller = await client.verifyAccessToken({ accessToken: await mint({ scope: '' }) });
    expect(caller.principal.scopes).toEqual([]);
  });

  it('accepts a token with no scope claim and gives it no scopes', async () => {
    server.use(...tenant.handlers);
    const caller = await client.verifyAccessToken({ accessToken: await mint({ scope: undefined }) });
    expect(caller.principal.scopes).toEqual([]);
  });
});
