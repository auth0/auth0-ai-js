import { describe, expect, it } from 'vitest';
import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import { mcpClientOptionsFromEnv, resolveMcpClientOptions } from '../src/env.js';

const FULL = {
  AUTH0_DOMAIN: 'tenant.example.com',
  AUTH0_AUDIENCE: 'https://mcp.example.com',
  AUTH0_CLIENT_ID: 'client-from-env',
  AUTH0_CLIENT_SECRET: 'secret-from-env',
};

describe('mcpClientOptionsFromEnv', () => {
  it('maps the four variables to option names', () => {
    expect(mcpClientOptionsFromEnv(FULL)).toEqual({
      domain: 'tenant.example.com',
      audience: 'https://mcp.example.com',
      clientId: 'client-from-env',
      clientSecret: 'secret-from-env',
    });
  });

  it('treats unset, empty and whitespace-only variables as unset', () => {
    expect(mcpClientOptionsFromEnv({ AUTH0_DOMAIN: '', AUTH0_AUDIENCE: '   ', AUTH0_CLIENT_ID: '\t\n' })).toEqual({});
  });

  it('returns values untrimmed', () => {
    expect(mcpClientOptionsFromEnv({ AUTH0_DOMAIN: ' a.example.com ' })).toEqual({ domain: ' a.example.com ' });
  });

  it('reads process.env by default', () => {
    const before = process.env['AUTH0_DOMAIN'];
    process.env['AUTH0_DOMAIN'] = 'from-process.example.com';
    try {
      expect(mcpClientOptionsFromEnv().domain).toBe('from-process.example.com');
    } finally {
      if (before === undefined) delete process.env['AUTH0_DOMAIN'];
      else process.env['AUTH0_DOMAIN'] = before;
    }
  });
});

describe('resolveMcpClientOptions', () => {
  it('uses the environment when nothing is explicit', () => {
    expect(resolveMcpClientOptions(undefined, FULL)).toEqual({
      domain: 'tenant.example.com',
      audience: 'https://mcp.example.com',
      clientId: 'client-from-env',
      clientSecret: 'secret-from-env',
    });
  });

  it('lets explicit values win over the environment', () => {
    const resolved = resolveMcpClientOptions({ domain: 'explicit.example.com', clientId: 'explicit-client' }, FULL);
    expect(resolved.domain).toBe('explicit.example.com');
    expect(resolved.clientId).toBe('explicit-client');
    expect(resolved.audience).toBe('https://mcp.example.com');
    expect(resolved.clientSecret).toBe('secret-from-env');
  });

  it('lets the environment fill a blank explicit string', () => {
    expect(resolveMcpClientOptions({ domain: '  ' }, FULL).domain).toBe('tenant.example.com');
  });

  it('passes other options through untouched', () => {
    const resolved = resolveMcpClientOptions({ requestTimeoutMs: 500, scopeMatching: 'strict' }, FULL);
    expect(resolved.requestTimeoutMs).toBe(500);
    expect(resolved.scopeMatching).toBe('strict');
  });

  it('names the option and the variable, never a value, when the domain is missing', () => {
    const error = capture(() => resolveMcpClientOptions({}, { AUTH0_AUDIENCE: 'https://secret-audience.example.com' }));
    expect(error).toBeInstanceOf(InvalidConfigurationError);
    expect(error.message).toContain('"domain"');
    expect(error.message).toContain('AUTH0_DOMAIN');
    expect(error.message).not.toContain('secret-audience');
  });

  it('names the option and the variable when the audience is missing', () => {
    const error = capture(() => resolveMcpClientOptions({ domain: 'secret-tenant.example.com' }, {}));
    expect(error).toBeInstanceOf(InvalidConfigurationError);
    expect(error.message).toContain('"audience"');
    expect(error.message).toContain('AUTH0_AUDIENCE');
    expect(error.message).not.toContain('secret-tenant');
  });

  it('does not require the optional client credentials', () => {
    const resolved = resolveMcpClientOptions({}, { AUTH0_DOMAIN: 'd.example.com', AUTH0_AUDIENCE: 'https://a' });
    expect(resolved.clientId).toBeUndefined();
    expect(resolved.clientSecret).toBeUndefined();
  });
});

function capture(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}
