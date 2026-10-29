import * as core from '@auth0/auth0-api-js';
import { AuthError } from '@auth0/auth0-api-js';
import { describe, expect, it } from 'vitest';
import { DownscopedTokenError, InsufficientScopeError, UnauthenticatedError } from '../src/errors.js';
import * as entry from '../src/index.js';

describe('UnauthenticatedError', () => {
  it('is a 401 invalid_token with a default message', () => {
    const err = new UnauthenticatedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('invalid_token');
    expect(err.name).toBe('UnauthenticatedError');
    expect(err.message).toBe('Unauthenticated');
  });

  it('accepts a message override and passes headers through', () => {
    const headers = { 'WWW-Authenticate': 'Bearer realm="mcp"' };
    const err = new UnauthenticatedError('No context', headers);
    expect(err.message).toBe('No context');
    expect(err.headers).toBe(headers);
  });

  it('has no headers by default', () => {
    expect(new UnauthenticatedError().headers).toBeUndefined();
  });

  it('is an instance of itself, AuthError and Error', () => {
    const err = new UnauthenticatedError();
    expect(err).toBeInstanceOf(UnauthenticatedError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('InsufficientScopeError', () => {
  it('is a 403 insufficient_scope with a generic default message', () => {
    const err = new InsufficientScopeError(['read:orders']);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('insufficient_scope');
    expect(err.name).toBe('InsufficientScopeError');
    expect(err.message).toBe('Missing one or more required scopes.');
  });

  it('accepts a message override and passes headers through', () => {
    const headers = { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' };
    const err = new InsufficientScopeError(['a'], 'Nope', headers);
    expect(err.message).toBe('Nope');
    expect(err.headers).toBe(headers);
  });

  it('never names the required scopes in the default message', () => {
    const err = new InsufficientScopeError(['read:orders', 'write:orders']);
    expect(err.message).not.toContain('read:orders');
    expect(err.message).not.toContain('write:orders');
    expect(String(err)).not.toContain('read:orders');
  });

  it('exposes the required scopes as a frozen copy', () => {
    const input = ['read:orders', 'write:orders'];
    const err = new InsufficientScopeError(input);
    input.push('admin');
    input[0] = 'changed';
    expect(err.requiredScopes).toEqual(['read:orders', 'write:orders']);
    expect(Object.isFrozen(err.requiredScopes)).toBe(true);
    expect(err.requiredScopes).not.toBe(input);
  });

  it('rejects mutation of the required scopes', () => {
    const err = new InsufficientScopeError(['a']);
    expect(() => (err.requiredScopes as string[]).push('b')).toThrow(TypeError);
  });

  it('is an instance of itself, AuthError and Error', () => {
    const err = new InsufficientScopeError([]);
    expect(err).toBeInstanceOf(InsufficientScopeError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('DownscopedTokenError', () => {
  it('is a 403 insufficient_scope with a generic default message', () => {
    const err = new DownscopedTokenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('insufficient_scope');
    expect(err.name).toBe('DownscopedTokenError');
    expect(err.message).toBe('Exchanged token did not include all requested scopes.');
  });

  it('accepts a message override and passes headers through', () => {
    const headers = { 'WWW-Authenticate': ['Bearer error="insufficient_scope"'] };
    const err = new DownscopedTokenError('Narrowed', headers);
    expect(err.message).toBe('Narrowed');
    expect(err.headers).toBe(headers);
  });

  it('carries no scope data', () => {
    const err = new DownscopedTokenError();
    expect(Object.keys(err)).not.toContain('requiredScopes');
    expect(Object.keys(err).filter((key) => /scope/i.test(key))).toEqual([]);
  });

  it('is an instance of itself, AuthError and Error, and not of its siblings', () => {
    const err = new DownscopedTokenError();
    expect(err).toBeInstanceOf(DownscopedTokenError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InsufficientScopeError);
    expect(err).not.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('core error classes re-exported from the package entry', () => {
  it('are the core classes themselves, so instanceof works against errors from every path', () => {
    expect(entry.AuthError).toBe(core.AuthError);
    expect(entry.InvalidConfigurationError).toBe(core.InvalidConfigurationError);

    // An error thrown inside the core package, and one thrown by this package.
    const fromCore = (() => {
      try {
        new core.ApiClient({
          domain: 'tenant.example.com',
          audience: 'https://mcp.example.com/mcp',
          clientId: 'client',
          clientSecret: 'secret',
          scopeMatching: 'bogus' as never,
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(fromCore).toBeInstanceOf(entry.InvalidConfigurationError);
    expect(() => new entry.MemoryIndexedTokenStore({ maxEntries: 0 })).toThrow(entry.InvalidConfigurationError);

    expect(new UnauthenticatedError()).toBeInstanceOf(entry.AuthError);
    expect(new entry.InsufficientScopeError(['a'])).toBeInstanceOf(entry.AuthError);
  });
});
