import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { decodeJwt } from 'jose';
import { AuthError, MissingClientAuthError } from '@auth0/auth0-api-js';
import type { CachedToken, IndexedTokenStore, TokenIndexMember } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import type { McpClient, VerifiedCaller } from '../src/client.js';
import { DownscopedTokenError } from '../src/errors.js';
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from './support/index.js';
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

function useTenant(scope = scopeMode.echo) {
  tenant = createAuth0Handlers({ key, scope });
  server.use(...tenant.handlers);
}

/** Minimal in-memory indexed store. */
class TestIndexedStore implements IndexedTokenStore {
  readonly entries = new Map<string, CachedToken>();
  readonly index = new Map<string, TokenIndexMember[]>();
  async get(k: string) {
    return this.entries.get(k);
  }
  async set(k: string, v: CachedToken) {
    this.entries.set(k, v);
  }
  async delete(k: string) {
    this.entries.delete(k);
  }
  async addIndexMember(indexKey: string, member: TokenIndexMember) {
    const rest = (this.index.get(indexKey) ?? []).filter((m) => m.tokenKey !== member.tokenKey);
    this.index.set(indexKey, [...rest, member]);
  }
  async listIndexMembers(indexKey: string) {
    return this.index.get(indexKey) ?? [];
  }
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

function subjectToken(sub = 'user|1', claims: Record<string, unknown> = {}) {
  return mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub, scope: 'openid', claims });
}

async function caller(client: McpClient, sub = 'user|1', claims: Record<string, unknown> = {}): Promise<VerifiedCaller> {
  return client.verifyAccessToken({ accessToken: await subjectToken(sub, claims) });
}

describe('request-scoped client: getTokenOnBehalfOf', () => {
  it('reuses a cached token on an identical second call (strict)', async () => {
    useTenant();
    const store = new TestStore();
    const client = makeClient({ tokenStore: store });
    const scoped = client.withToken(await caller(client));

    const first = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' });
    const second = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' });

    expect(tenant.state.exchangeCount).toBe(1);
    expect(second.accessToken).toBe(first.accessToken);
    expect(second.grantedScopes).toEqual(first.grantedScopes);
    expect(first.grantedScopes).toEqual(['read:a', 'write:a']);
  });

  it('does not reuse a cached superset for a narrower request in strict mode', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new TestStore() });
    const scoped = client.withToken(await caller(client));

    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' });
    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('reuses a cached superset for a narrower request in non_strict mode', async () => {
    useTenant();
    const client = makeClient({ tokenStore: new TestIndexedStore(), scopeMatching: 'non_strict' });
    const scoped = client.withToken(await caller(client));

    const wide = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' });
    const narrow = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(tenant.state.exchangeCount).toBe(1);
    expect(narrow.accessToken).toBe(wide.accessToken);
  });

  it('exchanges on every call when no store is configured', async () => {
    useTenant();
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });
    await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(tenant.state.exchangeCount).toBe(2);
  });

  it('treats an absent scope in the response as granting what was requested', async () => {
    useTenant(scopeMode.absent);
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(result.grantedScopes).toEqual(['read:a']);
  });

  it('rejects an empty scope in the response when scopes were requested', async () => {
    useTenant(scopeMode.empty);
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    await expect(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' })).rejects.toBeInstanceOf(
      DownscopedTokenError
    );
  });

  it('accepts an empty scope in the response when no scope was requested', async () => {
    useTenant(scopeMode.empty);
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });

    expect(result.grantedScopes).toEqual([]);
  });

  it('rejects a narrowed grant with a generic DownscopedTokenError', async () => {
    useTenant(scopeMode.fixed('read:a'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const err = await scoped
      .getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DownscopedTokenError);
    expect((err as DownscopedTokenError).statusCode).toBe(403);
    expect((err as DownscopedTokenError).message).not.toContain('write:a');
  });

  it('accepts a grant that is a superset of the request', async () => {
    useTenant(scopeMode.fixed('read:a write:a extra'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(result.grantedScopes).toEqual(['extra', 'read:a', 'write:a']);
  });

  it('caches the narrowed token under its granted scopes even though the call is rejected', async () => {
    useTenant(scopeMode.fixed('read:a'));
    const store = new TestIndexedStore();
    const client = makeClient({ tokenStore: store, scopeMatching: 'non_strict' });
    const scoped = client.withToken(await caller(client));

    await expect(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a write:a' })).rejects.toBeInstanceOf(
      DownscopedTokenError
    );
    // A later request the narrowed token does cover is served from the cache.
    const reused = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(tenant.state.exchangeCount).toBe(1);
    expect(reused.grantedScopes).toEqual(['read:a']);
  });

  it('never gives one caller the token cached for another caller', async () => {
    useTenant();
    const store = new TestIndexedStore();
    const client = makeClient({ tokenStore: store, scopeMatching: 'non_strict' });
    const alice = client.withToken(await caller(client, 'user|alice'));
    const bob = client.withToken(await caller(client, 'user|bob'));

    const a = await alice.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });
    const b = await bob.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });
    const aAgain = await alice.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' });

    expect(decodeJwt(a.accessToken).sub).toBe('user|alice');
    expect(decodeJwt(b.accessToken).sub).toBe('user|bob');
    expect(aAgain.accessToken).toBe(a.accessToken);
    expect(tenant.state.exchangeCount).toBe(2);
  });
});

describe('request-scoped client: scope edge cases and configuration', () => {
  it('accepts a request with duplicate and extra whitespace in the scope', async () => {
    useTenant(scopeMode.fixed('read:a'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a  read:a' });

    expect(result.grantedScopes).toEqual(['read:a']);
  });

  it('does not throw for an empty requested scope', async () => {
    useTenant(scopeMode.fixed('read:a'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    await expect(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: '' })).resolves.toBeDefined();
  });

  it('fails with the core missing-client-auth error when the client has no secret', async () => {
    useTenant();
    const client = makeClient({ clientSecret: undefined });
    const scoped = client.withToken(await caller(client));

    await expect(scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM })).rejects.toBeInstanceOf(MissingClientAuthError);
  });
});

describe('request-scoped client: other operations', () => {
  it('returns the caller principal', async () => {
    useTenant();
    const client = makeClient();
    const c = await caller(client, 'user|7', { org_id: 'org_1' });

    const principal = client.withToken(c).getPrincipal();

    expect(principal).toBe(c.principal);
    expect(principal.sub).toBe('user|7');
    expect(principal.orgId).toBe('org_1');
  });

  it('does not expose the access token through serialization or inspection', async () => {
    useTenant();
    const client = makeClient();
    const token = await subjectToken();
    const c = await client.verifyAccessToken({ accessToken: token });
    const scoped = client.withToken(c);

    expect(JSON.stringify(scoped)).toBe('{}');
    expect(inspect(scoped, { depth: 5, showHidden: true })).not.toContain(token);
    expect(Object.values(scoped).some((v) => v === token)).toBe(false);
  });

  it('returns normalized grantedScopes for client credentials, from the response', async () => {
    useTenant(scopeMode.fixed('b a a'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' });

    expect(result.grantedScopes).toEqual(['a', 'b']);
    expect(result.accessToken).toEqual(expect.any(String));
    expect(tenant.state.clientCredentialsCount).toBe(1);
  });

  it('falls back to the requested scopes for client credentials when the response has none', async () => {
    useTenant(scopeMode.absent);
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'b a' });

    expect(result.grantedScopes).toEqual(['a', 'b']);
  });

  it('rejects a client credentials grant that lacks a requested scope', async () => {
    useTenant(scopeMode.fixed('a'));
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const err = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a b' }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err).not.toBeInstanceOf(DownscopedTokenError);
    expect(err.cause).toBeInstanceOf(DownscopedTokenError);
  });

  it('rejects an empty client credentials grant when scopes were requested', async () => {
    useTenant(scopeMode.empty);
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const err = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM, scope: 'a' }).catch((e) => e);

    expect(err).not.toBeInstanceOf(AuthError);
    expect(err.cause).toBeInstanceOf(DownscopedTokenError);
  });

  it('reports no granted scopes for an empty client credentials response when none were requested', async () => {
    useTenant(scopeMode.empty);
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });

    expect(result.grantedScopes).toEqual([]);
  });

  it('returns no granted scopes for client credentials when nothing was requested or returned', async () => {
    useTenant(scopeMode.absent);
    const client = makeClient();
    const scoped = client.withToken(await caller(client));

    const result = await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });

    expect(result.grantedScopes).toEqual([]);
  });

  it('requests a connection token with the caller token and is not cached', async () => {
    useTenant();
    const seen: Record<string, string>[] = [];
    server.use(
      http.post(tenant.tokenEndpoint, async ({ request }) => {
        const params = Object.fromEntries(new URLSearchParams(await request.text()));
        if (!params['requested_token_type']) return undefined;
        seen.push(params);
        return HttpResponse.json({
          access_token: 'connection-token',
          expires_in: 3600,
          scope: 'repo',
          token_type: 'Bearer',
        });
      })
    );
    const client = makeClient({ tokenStore: new TestStore() });
    const token = await subjectToken();
    const scoped = client.withToken(await client.verifyAccessToken({ accessToken: token }));

    const first = await scoped.getTokenForConnection({ connection: 'github', loginHint: 'octo' });
    await scoped.getTokenForConnection({ connection: 'github' });

    expect(first.accessToken).toBe('connection-token');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.['subject_token']).toBe(token);
    expect(seen[0]?.['connection']).toBe('github');
    expect(seen[0]?.['login_hint']).toBe('octo');
    expect(seen[1]?.['login_hint']).toBeUndefined();
  });
});
