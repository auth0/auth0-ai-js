import { describe, expect, it } from 'vitest';
import { UnauthenticatedError } from '../src/errors.js';
import {
  getCallerMcpClient,
  getCallerMcpClientOrThrow,
  getCallerPrincipal,
  getRequestContext,
  runWithRequestContext,
} from '../src/request-context.js';
import type { Principal, RequestContext, RequestScopedMcpClient } from '../src/types.js';

function makeContext(sub: string, scopes: string[] = []): RequestContext {
  const principal: Principal = { sub, expiresAt: 0, scopes, permissions: null, clientId: null, orgId: null };
  const mcpClient = { getPrincipal: () => principal } as unknown as RequestScopedMcpClient;
  return { principal, mcpClient };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('request context', () => {
  it('returns undefined and throws UnauthenticatedError outside a request', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getCallerPrincipal()).toBeUndefined();
    expect(getCallerMcpClient()).toBeUndefined();
    expect(() => getCallerMcpClientOrThrow()).toThrow(UnauthenticatedError);
  });

  it('exposes principal and client inside a request and returns fn result', () => {
    const ctx = makeContext('a');
    const result = runWithRequestContext(ctx, () => {
      expect(getRequestContext()).toBe(ctx);
      expect(getCallerPrincipal()).toBe(ctx.principal);
      expect(getCallerMcpClientOrThrow()).toBe(ctx.mcpClient);
      expect(getCallerMcpClient()).toBe(ctx.mcpClient);
      return 42;
    });
    expect(result).toBe(42);
  });

  it('restores the outer context after a nested run', () => {
    const outer = makeContext('outer');
    const inner = makeContext('inner');
    runWithRequestContext(outer, () => {
      runWithRequestContext(inner, () => {
        expect(getCallerPrincipal()?.sub).toBe('inner');
      });
      expect(getCallerPrincipal()?.sub).toBe('outer');
    });
  });

  it('survives awaits, timers and promise chains', async () => {
    await runWithRequestContext(makeContext('async'), async () => {
      await delay(1);
      expect(getCallerPrincipal()?.sub).toBe('async');
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(getCallerPrincipal()?.sub).toBe('async');
      await Promise.resolve().then(() => delay(1)).then(() => {
        expect(getCallerPrincipal()?.sub).toBe('async');
      });
    });
  });

  it('does not leak after fn settles, including on throw and rejection', async () => {
    runWithRequestContext(makeContext('x'), () => undefined);
    expect(getRequestContext()).toBeUndefined();
    expect(() =>
      runWithRequestContext(makeContext('x'), () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(getRequestContext()).toBeUndefined();
    await expect(
      runWithRequestContext(makeContext('x'), async () => {
        await delay(1);
        throw new Error('later');
      })
    ).rejects.toThrow('later');
    expect(getRequestContext()).toBeUndefined();
  });

  it('isolates 100 concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        runWithRequestContext(makeContext(`user-${i}`), async () => {
          const seen: string[] = [];
          for (let step = 0; step < 4; step++) {
            await delay(Math.random() * 5);
            seen.push(getCallerPrincipal()!.sub);
            seen.push(getCallerMcpClientOrThrow().getPrincipal().sub);
          }
          return seen;
        })
      )
    );
    results.forEach((seen, i) => {
      expect(new Set(seen)).toEqual(new Set([`user-${i}`]));
    });
  });

  it('keeps the first request isolated while all others start and finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const total = 50;
    const first = runWithRequestContext(makeContext('first'), async () => {
      await gate;
      return [getCallerPrincipal()?.sub, getCallerMcpClientOrThrow().getPrincipal().sub];
    });
    const others = Array.from({ length: total - 1 }, (_, i) =>
      runWithRequestContext(makeContext(`other-${i}`), async () => {
        if (++started === total - 1) release();
        await delay(1);
        return getCallerPrincipal()?.sub;
      })
    );
    expect(await first).toEqual(['first', 'first']);
    expect(await Promise.all(others)).toEqual(others.map((_, i) => `other-${i}`));
  });
});
