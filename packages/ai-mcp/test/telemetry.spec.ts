import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { ApiClient, InvalidConfigurationError } from '@auth0/auth0-api-js';
import { createMcpClient } from '../src/client.js';
import { resolveHandlerClient } from '../src/handler.js';
import type { McpClient } from '../src/client.js';
import { PACKAGE_NAME, VERSION } from '../src/version.js';
import { createAuth0Handlers, createTestKey, mintAccessToken } from './support/index.js';
import type { TestKey } from './support/index.js';

const DOMAIN = 'tenant.example.com';
const AUDIENCE = 'https://mcp.example.com';
const DOWNSTREAM = 'https://downstream.example.com/resource';

interface Seen {
  kind: 'discovery' | 'jwks' | 'token';
  header: string | null;
}

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers> = undefined as never;
let seen: Seen[] = [];
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: 'error' });
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    const kind = url.pathname.includes('openid-configuration')
      ? 'discovery'
      : url.href === tenant.jwksUri
        ? 'jwks'
        : url.href === tenant.tokenEndpoint
          ? 'token'
          : undefined;
    if (kind !== undefined) seen.push({ kind, header: request.headers.get('auth0-client') });
  });
});
afterEach(() => {
  server.resetHandlers();
  seen = [];
});
afterAll(() => server.close());

function makeClient(extra: Partial<Parameters<typeof createMcpClient>[0]> = {}): McpClient {
  tenant = createAuth0Handlers({ key });
  server.use(...tenant.handlers);
  return createMcpClient({
    domain: DOMAIN,
    audience: AUDIENCE,
    clientId: 'mcp-client',
    clientSecret: 'secret',
    ...extra,
  });
}

function decode(header: string | null): Record<string, unknown> {
  return JSON.parse(Buffer.from(header!, 'base64').toString('utf8')) as Record<string, unknown>;
}

async function exerciseAll(client: McpClient): Promise<void> {
  const accessToken = await mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: 'user|1', scope: 'openid' });
  const caller = await client.verifyAccessToken({ accessToken });
  const scoped = client.withToken(caller);
  await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });
  await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
}

describe('telemetry identity', () => {
  it('sends the wrapper name and version, and the core env, on token, discovery and JWKS requests', async () => {
    await exerciseAll(makeClient());

    expect(new Set(seen.map((s) => s.kind))).toEqual(new Set(['discovery', 'jwks', 'token']));
    expect(seen.filter((s) => s.kind === 'token').length).toBeGreaterThanOrEqual(2);
    for (const request of seen) {
      const data = decode(request.header);
      expect(data.name).toBe('@auth0/ai-mcp');
      expect(data.version).toBe(VERSION);
      expect(data.env).toEqual({ '@auth0/auth0-api-js': expect.stringMatching(/^\d+\.\d+\.\d+/) });
    }
  });

  it('uses the package constants', () => {
    expect(PACKAGE_NAME).toBe('@auth0/ai-mcp');
    expect(VERSION).not.toBe('');
  });

  it('sends no header with telemetry { enabled: false }', async () => {
    await exerciseAll(makeClient({ telemetry: { enabled: false } }));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.header === null)).toBe(true);
  });

  it('forwards telemetry given inline to a handler and sends no header for { enabled: false }', async () => {
    tenant = createAuth0Handlers({ key });
    server.use(...tenant.handlers);
    const inline = { domain: DOMAIN, audience: AUDIENCE, clientId: 'mcp-client', clientSecret: 'secret' };

    await exerciseAll(resolveHandlerClient({ ...inline, telemetry: { enabled: false } }).client);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.header === null)).toBe(true);

    seen = [];
    await exerciseAll(resolveHandlerClient(inline).client);
    expect(decode(seen[0]!.header).name).toBe('@auth0/ai-mcp');
  });

  it('sends a caller supplied identity instead of the package identity', async () => {
    await exerciseAll(makeClient({ telemetry: { name: 'my-server', version: '3.2.1' } }));

    for (const request of seen) {
      expect(decode(request.header)).toMatchObject({ name: 'my-server', version: '3.2.1' });
    }
  });

  it('adds no telemetry to a supplied apiClient', async () => {
    tenant = createAuth0Handlers({ key });
    server.use(...tenant.handlers);
    const apiClient = new ApiClient({ domain: DOMAIN, audience: AUDIENCE });
    const client = createMcpClient({ domain: DOMAIN, audience: AUDIENCE, apiClient });
    const accessToken = await mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: 'user|1', scope: 'openid' });

    await client.verifyAccessToken({ accessToken });

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(decode(request.header).name).not.toBe('@auth0/ai-mcp');
    }
  });

  it.each([
    ['an identity', { name: 'x', version: '1' }],
    ['an opt-out', { enabled: false as const }],
  ])('rejects apiClient combined with telemetry (%s)', (_name, telemetry) => {
    const apiClient = new ApiClient({ domain: DOMAIN, audience: AUDIENCE });
    expect(() => createMcpClient({ domain: DOMAIN, audience: AUDIENCE, apiClient, telemetry })).toThrow(
      InvalidConfigurationError
    );
  });
});
