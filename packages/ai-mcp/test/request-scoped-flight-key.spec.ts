import { describe, expect, it } from 'vitest';
import type { ApiClient, OnBehalfOfTokenResult, VerifiedToken } from '@auth0/auth0-api-js';
import { createRequestScopedClient } from '../src/request-scoped-client.js';
import type { ExchangeIdentity } from '../src/request-scoped-client.js';
import { SingleFlight } from '../src/single-flight.js';
import type { Principal } from '../src/types.js';

const DOWNSTREAM = 'https://downstream.example.com/resource';

/** The claims the single flight key is built from. Each one must be handled by the guard. */
const KEYED_CLAIMS = ['iss', 'client_id', 'azp', 'sub', 'org_id', 'sid', 'jti'] as const;

const IDENTITY: ExchangeIdentity = {
  tenant: 'tenant.example.com',
  clientId: 'mcp-client',
  audience: 'https://mcp.example.com',
  layout: 'strict',
};

const PRINCIPAL: Principal = {
  sub: 'user|1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scopes: [],
  permissions: null,
  clientId: null,
  orgId: null,
};

/** Claims every caller shares, so a test changes exactly one claim. */
const BASE_CLAIMS: Record<string, unknown> = {
  iss: 'https://tenant.example.com/',
  client_id: 'caller-client',
  azp: 'caller-azp',
  sub: 'user|1',
  org_id: 'org_1',
  sid: 'session-1',
  jti: 'token-1',
};

/** A core client double that records how many exchanges reached it and answers slowly enough to overlap. */
function stubApiClient() {
  const state = { exchanges: 0 };
  const apiClient = {
    async getTokenOnBehalfOf(): Promise<OnBehalfOfTokenResult> {
      const n = ++state.exchanges;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        accessToken: `token-${n}`,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        grantedScopes: ['read:a'],
      } as OnBehalfOfTokenResult;
    },
  } as unknown as ApiClient;
  return { apiClient, state };
}

function callerWith(apiClient: ApiClient, exchanges: SingleFlight<OnBehalfOfTokenResult>, claims: Record<string, unknown>) {
  const verified: VerifiedToken = { accessToken: 'the-access-token', claims: claims as VerifiedToken['claims'] };
  return createRequestScopedClient({
    apiClient,
    tokenStore: undefined,
    principal: PRINCIPAL,
    verified,
    exchanges,
    exchangeIdentity: IDENTITY,
  });
}

function without(claims: Record<string, unknown>, name: string): Record<string, unknown> {
  const copy = { ...claims };
  delete copy[name];
  return copy;
}

describe('single flight key: callers whose claims cannot be keyed', () => {
  it('shares one exchange between callers with identical string claims (control)', async () => {
    const { apiClient, state } = stubApiClient();
    const exchanges = new SingleFlight<OnBehalfOfTokenResult>();
    const one = callerWith(apiClient, exchanges, BASE_CLAIMS);
    const two = callerWith(apiClient, exchanges, { ...BASE_CLAIMS });

    await Promise.all([
      one.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      two.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(state.exchanges).toBe(1);
  });

  it.each(KEYED_CLAIMS)(
    'exchanges alone when %s is not a string, although another caller differs only in that claim',
    async (name) => {
      const { apiClient, state } = stubApiClient();
      const exchanges = new SingleFlight<OnBehalfOfTokenResult>();
      const odd = callerWith(apiClient, exchanges, { ...BASE_CLAIMS, [name]: 42 });
      const plain = callerWith(apiClient, exchanges, without(BASE_CLAIMS, name));

      const [first, second] = await Promise.all([
        odd.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
        plain.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      ]);

      expect(state.exchanges).toBe(2);
      expect(first.accessToken).not.toBe(second.accessToken);
    }
  );

  it.each(KEYED_CLAIMS)(
    'exchanges alone when two callers differ only in a non-string %s',
    async (name) => {
      const { apiClient, state } = stubApiClient();
      const exchanges = new SingleFlight<OnBehalfOfTokenResult>();
      const one = callerWith(apiClient, exchanges, { ...BASE_CLAIMS, [name]: 42 });
      const two = callerWith(apiClient, exchanges, { ...BASE_CLAIMS, [name]: { nested: true } });

      await Promise.all([
        one.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
        two.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      ]);

      expect(state.exchanges).toBe(2);
    }
  );

  it('does not share an exchange between two identical callers whose claim is not a string', async () => {
    const { apiClient, state } = stubApiClient();
    const exchanges = new SingleFlight<OnBehalfOfTokenResult>();
    const one = callerWith(apiClient, exchanges, { ...BASE_CLAIMS, sid: 42 });
    const two = callerWith(apiClient, exchanges, { ...BASE_CLAIMS, sid: 42 });

    await Promise.all([
      one.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
      two.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: 'read:a' }),
    ]);

    expect(state.exchanges).toBe(2);
  });
});
