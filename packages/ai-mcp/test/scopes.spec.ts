import { describe, expect, it, vi } from 'vitest';
import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import { InsufficientScopeError, UnauthenticatedError } from '../src/errors.js';
import { runWithRequestContext, getCallerPrincipal } from '../src/request-context.js';
import { requireScopes, withRequiredScopes } from '../src/scopes.js';
import type { Principal, RequestContext, RequestScopedMcpClient } from '../src/types.js';

function makePrincipal(sub: string, scopes: string[], permissions: string[] | null = null): Principal {
  return { sub, expiresAt: 0, scopes, permissions, clientId: null, orgId: null };
}

function makeContext(principal: Principal): RequestContext {
  return { principal, mcpClient: { getPrincipal: () => principal } as unknown as RequestScopedMcpClient };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('requireScopes', () => {
  const p = makePrincipal('u', ['read', 'write']);

  it('passes when all scopes are present, for string, space-delimited and list', () => {
    expect(() => requireScopes('read', p)).not.toThrow();
    expect(() => requireScopes('read write', p)).not.toThrow();
    expect(() => requireScopes(['write', 'read'], p)).not.toThrow();
    expect(() => requireScopes('  read \t write ', p)).not.toThrow();
  });

  it('rejects a requirement that names no scope', () => {
    expect(() => requireScopes([], p)).toThrow(InvalidConfigurationError);
    expect(() => requireScopes('', p)).toThrow(InvalidConfigurationError);
    expect(() => requireScopes('   ', p)).toThrow(InvalidConfigurationError);
    expect(() => requireScopes([])).toThrow(InvalidConfigurationError);
  });

  it('rejects a list that contains a blank or non-string entry', () => {
    expect(() => requireScopes(['read', ''], p)).toThrow(InvalidConfigurationError);
    expect(() => requireScopes(['read', '  '], p)).toThrow(InvalidConfigurationError);
    expect(() => requireScopes(['read', 5 as unknown as string], p)).toThrow(InvalidConfigurationError);
    expect(() => requireScopes(['read', null as unknown as string], p)).toThrow(InvalidConfigurationError);
  });

  it('does not echo the offending value in the error', () => {
    expect(() => requireScopes(['read', 12345 as unknown as string], p)).toThrow(/non-blank string/);
    expect(() => requireScopes(['read', 12345 as unknown as string], p)).not.toThrow(/12345/);
  });

  it('requires every scope (AND semantics)', () => {
    expect(() => requireScopes(['read', 'admin'], p)).toThrow(InsufficientScopeError);
    expect(() => requireScopes('admin', p)).toThrow(InsufficientScopeError);
  });

  it('requires every scope of a space-delimited string', () => {
    expect(() => requireScopes('a b', makePrincipal('u', ['a']))).toThrow(InsufficientScopeError);
  });

  it('accepts duplicate requirements when held', () => {
    expect(() => requireScopes(['read', 'read'], p)).not.toThrow();
  });

  it('ignores permissions', () => {
    const rbac = makePrincipal('u', [], ['read']);
    expect(() => requireScopes('read', rbac)).toThrow(InsufficientScopeError);
  });

  it('throws a generic error that does not leak held scopes', () => {
    const secret = makePrincipal('u', ['held:secret-scope']);
    try {
      requireScopes('admin', secret);
      expect.unreachable();
    } catch (error) {
      const err = error as InsufficientScopeError;
      expect(err).toBeInstanceOf(InsufficientScopeError);
      expect(err.statusCode).toBe(403);
      expect(err.message).not.toContain('held:secret-scope');
      expect(err.requiredScopes).toEqual(['admin']);
    }
  });

  it('defaults to the current caller and throws UnauthenticatedError outside a request', () => {
    expect(() => requireScopes('read')).toThrow(UnauthenticatedError);
    runWithRequestContext(makeContext(p), () => {
      expect(() => requireScopes('read')).not.toThrow();
      expect(() => requireScopes('admin')).toThrow(InsufficientScopeError);
    });
  });
});

describe('withRequiredScopes', () => {
  it('throws when it is created with a requirement that names no scope', () => {
    const handler = () => 'ok';
    expect(() => withRequiredScopes('', handler)).toThrow(InvalidConfigurationError);
    expect(() => withRequiredScopes([], handler)).toThrow(InvalidConfigurationError);
    expect(() => withRequiredScopes(['read', ' '], handler)).toThrow(InvalidConfigurationError);
    expect(() => withRequiredScopes(['read', 1 as unknown as string], handler)).toThrow(InvalidConfigurationError);
  });

  it('runs the handler with its arguments when scopes are held', async () => {
    const handler = vi.fn(async (a: number, b: number) => a + b);
    const wrapped = withRequiredScopes('read', handler);
    const result = await runWithRequestContext(makeContext(makePrincipal('u', ['read'])), () => wrapped(1, 2));
    expect(result).toBe(3);
    expect(handler).toHaveBeenCalledWith(1, 2);
  });

  it('supports synchronous handlers', async () => {
    const wrapped = withRequiredScopes(['read'], () => 'sync');
    expect(await runWithRequestContext(makeContext(makePrincipal('u', ['read'])), () => wrapped())).toBe('sync');
  });

  it('returns a sanitized error result without calling the handler on denial', async () => {
    const handler = vi.fn();
    const wrapped = withRequiredScopes(['read', 'admin'], handler);
    const result = await runWithRequestContext(makeContext(makePrincipal('u', ['read', 'held:secret'])), () =>
      wrapped()
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Missing one or more required scopes.' }],
      isError: true,
      _meta: { error: 'insufficient_scope' },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('held:secret');
    expect(text).not.toContain('admin');
  });

  it('does not swallow non-scope errors raised outside a request', async () => {
    const wrapped = withRequiredScopes('read', async () => 'x');
    await expect(wrapped()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('propagates handler errors unchanged, including InsufficientScopeError', async () => {
    const boom = new Error('handler failed');
    const inner = new InsufficientScopeError(['other']);
    const ctx = makeContext(makePrincipal('u', ['read']));
    await expect(
      runWithRequestContext(ctx, () =>
        withRequiredScopes('read', async () => {
          throw boom;
        })()
      )
    ).rejects.toBe(boom);
    await expect(
      runWithRequestContext(ctx, () =>
        withRequiredScopes('read', async () => {
          throw inner;
        })()
      )
    ).rejects.toBe(inner);
  });

  it('keeps 60 concurrent callers isolated through the wrapper', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const allowed = i % 2 === 0;
        const principal = makePrincipal(`user-${i}`, allowed ? ['tool:run'] : ['other']);
        const wrapped = withRequiredScopes('tool:run', async () => {
          await delay(Math.random() * 5);
          return getCallerPrincipal()?.sub;
        });
        return runWithRequestContext(makeContext(principal), async () => {
          await delay(Math.random() * 5);
          const out = await wrapped();
          await delay(Math.random() * 5);
          return { i, allowed, out, after: getCallerPrincipal()?.sub };
        });
      })
    );
    for (const { i, allowed, out, after } of results) {
      expect(after).toBe(`user-${i}`);
      if (allowed) expect(out).toBe(`user-${i}`);
      else expect(out).toMatchObject({ isError: true });
    }
  });
});
