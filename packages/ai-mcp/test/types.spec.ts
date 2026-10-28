import type { ApiClient, IndexedTokenStore, OnBehalfOfTokenResult, TokenSet, TokenStore } from '@auth0/auth0-api-js';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  ClientCredentialsTokenResult,
  McpClientOptions,
  OnBehalfOfOptions,
  OrganizationPolicy,
  Principal,
  RequestContext,
  RequestScopedMcpClient,
  ScopeMatching,
  ConnectionTokenResult,
} from '../src/types.js';

const principal: Principal = {
  sub: 'auth0|123',
  expiresAt: 1_900_000_000,
  scopes: ['read:orders'],
  permissions: null,
  clientId: null,
  orgId: null,
};

describe('Principal', () => {
  it('accepts a complete value', () => {
    expectTypeOf(principal).toMatchTypeOf<Principal>();
  });

  it('has the expected field types', () => {
    expectTypeOf<Principal['sub']>().toEqualTypeOf<string>();
    expectTypeOf<Principal['expiresAt']>().toEqualTypeOf<number>();
    expectTypeOf<Principal['scopes']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Principal['permissions']>().toEqualTypeOf<readonly string[] | null>();
    expectTypeOf<Principal['clientId']>().toEqualTypeOf<string | null>();
    expectTypeOf<Principal['orgId']>().toEqualTypeOf<string | null>();
  });

  it('is readonly', () => {
    const mutate = (p: Principal) => {
      // @ts-expect-error sub is readonly
      p.sub = 'other';
      // @ts-expect-error expiresAt is readonly
      p.expiresAt = 1;
      // @ts-expect-error orgId is readonly
      p.orgId = 'org_1';
    };
    void mutate;
  });

  it('rejects a value missing a required field', () => {
    // @ts-expect-error sub is required
    const bad: Principal = { expiresAt: 1, scopes: [], permissions: null, clientId: null, orgId: null };
    void bad;
  });
});

describe('RequestContext', () => {
  it('has a principal and a request scoped client, both readonly', () => {
    expectTypeOf<RequestContext['principal']>().toEqualTypeOf<Principal>();
    expectTypeOf<RequestContext['mcpClient']>().toEqualTypeOf<RequestScopedMcpClient>();
    const mutate = (ctx: RequestContext) => {
      // @ts-expect-error principal is readonly
      ctx.principal = principal;
      // @ts-expect-error mcpClient is readonly
      ctx.mcpClient = {} as RequestScopedMcpClient;
    };
    void mutate;
  });
});

describe('RequestScopedMcpClient', () => {
  it('exposes the expected methods and no way to read the token', () => {
    expectTypeOf<RequestScopedMcpClient['getTokenOnBehalfOf']>().toEqualTypeOf<
      (options: OnBehalfOfOptions) => Promise<OnBehalfOfTokenResult>
    >();
    expectTypeOf<RequestScopedMcpClient['getPrincipal']>().toEqualTypeOf<() => Principal>();
    expectTypeOf<RequestScopedMcpClient['getClientCredentialsToken']>().returns.resolves.toEqualTypeOf<ClientCredentialsTokenResult>();
    expectTypeOf<RequestScopedMcpClient['getTokenForConnection']>().returns.resolves.toEqualTypeOf<ConnectionTokenResult>();
    expectTypeOf<keyof RequestScopedMcpClient>().toEqualTypeOf<
      'getTokenOnBehalfOf' | 'getClientCredentialsToken' | 'getTokenForConnection' | 'getPrincipal'
    >();
  });

  it('requires an audience for OBO and a connection for service tokens', () => {
    const call = (client: RequestScopedMcpClient) => {
      // @ts-expect-error audience is required
      void client.getTokenOnBehalfOf({ scope: 'a' });
      // @ts-expect-error connection is required
      void client.getTokenForConnection({ loginHint: 'x' });
    };
    void call;
  });
});

describe('result types', () => {
  it('extends the core token set with grantedScopes', () => {
    expectTypeOf<ClientCredentialsTokenResult>().toMatchTypeOf<TokenSet>();
    expectTypeOf<ClientCredentialsTokenResult['grantedScopes']>().toEqualTypeOf<string[]>();
  });

  it('tracks the core connection token return type', () => {
    expectTypeOf<ConnectionTokenResult>().toEqualTypeOf<
      Awaited<ReturnType<ApiClient['getAccessTokenForConnection']>>
    >();
  });
});

describe('McpClientOptions', () => {
  it('accepts the minimal options', () => {
    const options: McpClientOptions = { domain: 'example.auth0.com', audience: 'https://mcp.example.com' };
    void options;
  });

  it('requires domain and audience', () => {
    // @ts-expect-error audience is required
    const noAudience: McpClientOptions = { domain: 'example.auth0.com' };
    // @ts-expect-error domain is required
    const noDomain: McpClientOptions = { audience: 'https://mcp.example.com' };
    void noAudience;
    void noDomain;
  });

  it('accepts the full option set', () => {
    const options: McpClientOptions = {
      domain: 'example.auth0.com',
      audience: 'https://mcp.example.com',
      clientId: 'id',
      clientSecret: 'secret',
      tokenStore: {} as IndexedTokenStore,
      scopeMatching: 'non_strict',
      organizationPolicy: 'required',
      organizationId: ['org_1', 'org_2'],
      dpop: { mode: 'required' },
      apiClient: {} as ApiClient,
    };
    void options;
  });

  it('accepts a plain or an indexed token store', () => {
    const indexed: McpClientOptions = { domain: 'd', audience: 'a', tokenStore: {} as IndexedTokenStore };
    const plain: McpClientOptions = { domain: 'd', audience: 'a', tokenStore: {} as TokenStore };
    // @ts-expect-error a store must at least implement get
    const bad: McpClientOptions = { domain: 'd', audience: 'a', tokenStore: { set: async () => {}, delete: async () => {} } };
    void indexed;
    void plain;
    void bad;
  });

  it('rejects a bad scopeMatching or organizationPolicy', () => {
    // @ts-expect-error not a scope matching mode
    const badMatching: McpClientOptions = { domain: 'd', audience: 'a', scopeMatching: 'loose' };
    // @ts-expect-error not an organization policy
    const badPolicy: McpClientOptions = { domain: 'd', audience: 'a', organizationPolicy: 'maybe' };
    void badMatching;
    void badPolicy;
  });

  it('accepts a single organization id or a list, and nothing else', () => {
    expectTypeOf<McpClientOptions['organizationId']>().toEqualTypeOf<string | string[] | undefined>();
  });
});

describe('literal unions', () => {
  it('are exactly the supported values', () => {
    expectTypeOf<ScopeMatching>().toEqualTypeOf<'strict' | 'non_strict'>();
    expectTypeOf<OrganizationPolicy>().toEqualTypeOf<'required' | 'allow'>();
  });
});
