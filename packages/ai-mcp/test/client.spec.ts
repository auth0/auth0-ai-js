import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { setupServer } from 'msw/node';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import {
  ApiClient,
  InvalidConfigurationError,
  MissingClientAuthError,
  MissingOrganizationError,
  AuthError,
  OrganizationNotAllowedError,
  VerifyAccessTokenError,
} from '@auth0/auth0-api-js';
import type { CachedToken, IndexedTokenStore, TokenIndexMember } from '@auth0/auth0-api-js';
import { ForeignCallerError, createMcpClient } from '../src/client.js';
import type { McpClient } from '../src/client.js';
import { UnauthenticatedError } from '../src/errors.js';
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

function useTenant() {
  tenant = createAuth0Handlers({ key });
  server.use(...tenant.handlers);
}

class PlainStore {
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

class IndexedStore extends PlainStore implements IndexedTokenStore {
  readonly index = new Map<string, TokenIndexMember[]>();
  async addIndexMember(indexKey: string, member: TokenIndexMember) {
    this.index.set(indexKey, [...(this.index.get(indexKey) ?? []), member]);
  }
  async listIndexMembers(indexKey: string) {
    return this.index.get(indexKey) ?? [];
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

function token(sub = 'user|1', claims: Record<string, unknown> = {}) {
  return mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub, scope: 'openid', claims });
}

async function dpopMaterial(accessTokenFor: (jkt: string) => Promise<string>, url: string, method: string) {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const accessToken = await accessTokenFor(await calculateJwkThumbprint(jwk));
  const ath = createHash('sha256').update(accessToken).digest('base64url');
  const dpopProof = await new SignJWT({ htm: method, htu: url, jti: randomUUID(), ath })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
    .setIssuedAt()
    .sign(privateKey);
  return { accessToken, dpopProof };
}

describe('createMcpClient construction', () => {
  it.each([
    [undefined, 'allowed'],
    ['allowed', 'allowed'],
    ['required', 'required'],
    ['disabled', 'disabled'],
  ] as const)('reports dpopMode for dpop.mode %s', (mode, expected) => {
    expect(makeClient(mode === undefined ? {} : { dpop: { mode } }).dpopMode).toBe(expected);
  });

  it('reports allowed for a supplied apiClient, whose mode cannot be read', () => {
    const apiClient = new ApiClient({ domain: 'tenant.example.com', audience: AUDIENCE, dpop: { mode: 'required' } });
    expect(createMcpClient({ domain: 'tenant.example.com', audience: AUDIENCE, apiClient }).dpopMode).toBe('allowed');
  });

  it('throws InvalidConfigurationError at construction for non_strict without a store', () => {
    expect(() => makeClient({ scopeMatching: 'non_strict' })).toThrow(InvalidConfigurationError);
  });

  it('throws InvalidConfigurationError at construction for non_strict with a plain store', () => {
    expect(() => makeClient({ scopeMatching: 'non_strict', tokenStore: new PlainStore() })).toThrow(
      InvalidConfigurationError
    );
  });

  it('throws for a store that implements only one index method', () => {
    const half = Object.assign(new PlainStore(), { addIndexMember: async () => undefined });
    expect(() => makeClient({ scopeMatching: 'non_strict', tokenStore: half })).toThrow(InvalidConfigurationError);
  });

  it('accepts non_strict with an indexed store', () => {
    expect(() => makeClient({ scopeMatching: 'non_strict', tokenStore: new IndexedStore() })).not.toThrow();
  });

  it('accepts strict mode with no store or a plain store', () => {
    expect(() => makeClient()).not.toThrow();
    expect(() => makeClient({ scopeMatching: 'strict', tokenStore: new PlainStore() })).not.toThrow();
  });

  it('throws when organizationId is set without the required organization policy', () => {
    expect(() => makeClient({ organizationId: 'org_1' })).toThrow(InvalidConfigurationError);
  });

  it('accepts a supplied apiClient together with a token store', () => {
    const apiClient = new ApiClient({ domain: 'tenant.example.com', audience: AUDIENCE });
    expect(() =>
      createMcpClient({ domain: 'tenant.example.com', audience: AUDIENCE, apiClient, tokenStore: new PlainStore() })
    ).not.toThrow();
  });

  it.each([
    ['clientId', { clientId: 'x' }],
    ['clientSecret', { clientSecret: 'x' }],
    ['scopeMatching', { scopeMatching: 'strict' as const }],
    ['organizationPolicy', { organizationPolicy: 'allow' as const }],
    ['organizationId', { organizationId: 'org_1' }],
    ['dpop', { dpop: { mode: 'allowed' as const } }],
  ])('rejects apiClient combined with %s', (_name, extra) => {
    const apiClient = new ApiClient({ domain: 'tenant.example.com', audience: AUDIENCE });
    expect(() => createMcpClient({ domain: 'tenant.example.com', audience: AUDIENCE, apiClient, ...extra })).toThrow(
      InvalidConfigurationError
    );
  });

  it('does not expose the core client', () => {
    expect('apiClient' in makeClient()).toBe(false);
  });
});

describe('verifyAccessToken', () => {
  it('returns the principal and hands core the exact claims object it produced', async () => {
    useTenant();
    const apiClient = new ApiClient({
      domain: 'tenant.example.com',
      audience: AUDIENCE,
      clientId: 'mcp-client',
      clientSecret: 'secret',
    });
    const verifySpy = vi.spyOn(apiClient, 'verifyAccessToken');
    const exchangeSpy = vi.spyOn(apiClient, 'getTokenOnBehalfOf');
    const client = createMcpClient({
      domain: 'tenant.example.com',
      audience: AUDIENCE,
      apiClient,
      tokenStore: new PlainStore(),
    });
    const accessToken = await token('user|9', { org_id: 'org_1' });

    const caller = await client.verifyAccessToken({ accessToken });
    await client.withToken(caller).getTokenOnBehalfOf({ audience: DOWNSTREAM });

    const coreClaims = await verifySpy.mock.results[0]!.value;
    const context = exchangeSpy.mock.calls[0]![2]!;
    expect(context.verified!.claims).toBe(coreClaims);
    expect(context.verified!.accessToken).toBe(accessToken);
    expect(exchangeSpy.mock.calls[0]![0]).toBe(accessToken);
    expect(caller.principal.sub).toBe('user|9');
    expect(caller.principal.orgId).toBe('org_1');
  });

  it('propagates core verification errors unchanged', async () => {
    useTenant();
    const client = makeClient();
    const bad = await mintAccessToken(key, { iss: tenant.issuer, aud: 'https://other.example.com' });

    await expect(client.verifyAccessToken({ accessToken: bad })).rejects.toBeInstanceOf(VerifyAccessTokenError);
  });

  it('enforces organization policy at ingress', async () => {
    useTenant();
    const client = makeClient({ organizationPolicy: 'required', organizationId: ['org_ok'] });

    await expect(client.verifyAccessToken({ accessToken: await token('user|1') })).rejects.toBeInstanceOf(
      MissingOrganizationError
    );
    await expect(
      client.verifyAccessToken({ accessToken: await token('user|1', { org_id: 'org_bad' }) })
    ).rejects.toBeInstanceOf(OrganizationNotAllowedError);
    const ok = await client.verifyAccessToken({ accessToken: await token('user|1', { org_id: 'org_ok' }) });
    expect(ok.principal.orgId).toBe('org_ok');
  });

  it('returns a frozen handle that does not reveal the token when serialized or inspected', async () => {
    useTenant();
    const client = makeClient();
    const accessToken = await token();

    const caller = await client.verifyAccessToken({ accessToken });

    expect(Object.isFrozen(caller)).toBe(true);
    expect(JSON.stringify(caller)).not.toContain(accessToken);
    expect(JSON.parse(JSON.stringify(caller))).toEqual({ principal: caller.principal });
    expect(inspect(caller, { depth: 6, showHidden: true })).not.toContain(accessToken);
    expect(Object.values(caller)).not.toContain(accessToken);
  });

  describe('DPoP', () => {
    const URL_ = 'https://mcp.example.com/mcp';

    it('rejects a Bearer token when DPoP is required', async () => {
      useTenant();
      const client = makeClient({ dpop: { mode: 'required' } });

      await expect(client.verifyAccessToken({ accessToken: await token() })).rejects.toThrow();
    });

    it('verifies a DPoP-bound token and exchanges it on behalf of the caller', async () => {
      useTenant();
      const client = makeClient({ dpop: { mode: 'required' }, tokenStore: new PlainStore() });
      const { accessToken, dpopProof } = await dpopMaterial(
        (jkt) => token('user|dpop', { cnf: { jkt } }),
        URL_,
        'POST'
      );

      const caller = await client.verifyAccessToken({
        accessToken,
        scheme: 'dpop',
        dpopProof,
        httpMethod: 'POST',
        httpUrl: URL_,
      });
      const scoped = client.withToken(caller);
      await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });
      await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

      expect(caller.principal.sub).toBe('user|dpop');
      expect(tenant.state.exchangeCount).toBe(1);
    });
  });
});

describe('withToken', () => {
  it('rejects values that this client did not produce with a programming error, not a 401', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new PlainStore() });
    const other = makeClient();
    const real = await client.verifyAccessToken({ accessToken: await token() });

    const foreign: Array<[string, () => unknown]> = [
      ['hand-built', () => client.withToken({ principal: real.principal })],
      ['spread copy', () => client.withToken({ ...real })],
      ['serialized copy', () => client.withToken(JSON.parse(JSON.stringify(real)))],
      ['prototype descendant', () => client.withToken(Object.create(real))],
      ['other client', () => other.withToken(real)],
      ['null', () => client.withToken(null as never)],
      ['undefined', () => client.withToken(undefined as never)],
    ];
    for (const [, call] of foreign) {
      const err = (() => {
        try {
          call();
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(ForeignCallerError);
      expect(err).not.toBeInstanceOf(AuthError);
      expect(err).not.toBeInstanceOf(UnauthenticatedError);
      expect((err as Error).message).toBe('Caller handle was not issued by this client.');
      expect((err as { statusCode?: number }).statusCode).toBeUndefined();
    }
    expect(() => client.withToken(real)).not.toThrow();
  });

  it('throws UnauthenticatedError once the caller token has expired', async () => {
    useTenant();
    const client = makeClient();
    const caller = await client.verifyAccessToken({ accessToken: await token() });
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 3600 * 1000);
    try {
      const err = (() => {
        try {
          client.withToken(caller);
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(UnauthenticatedError);
      expect(err).not.toBeInstanceOf(ForeignCallerError);
      expect((err as UnauthenticatedError).statusCode).toBe(401);
      expect((err as UnauthenticatedError).code).toBe('invalid_token');
    } finally {
      spy.mockRestore();
    }
    expect(() => client.withToken(caller)).not.toThrow();
  });

  it('fails with the core missing-client-auth error when the client has no secret', async () => {
    useTenant();
    const client = makeClient({ clientSecret: undefined, tokenStore: new PlainStore() });
    const scoped = client.withToken(await client.verifyAccessToken({ accessToken: await token() }));

    await expect(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM })).rejects.toBeInstanceOf(MissingClientAuthError);
  });

  it('exchanges through a store with the verified claims from the same client', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new PlainStore() });
    const scoped = client.withToken(await client.verifyAccessToken({ accessToken: await token() }));

    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(result.accessToken).toEqual(expect.any(String));
    expect(tenant.state.exchangeCount).toBe(1);
  });
});
