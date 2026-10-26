import { describe, expect, it, vi } from 'vitest';
import { SingleFlight } from '../src/single-flight.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SingleFlight', () => {
  it('runs the operation once for 10 concurrent callers with the same key', async () => {
    const flight = new SingleFlight<string>();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);

    const calls = Array.from({ length: 10 }, () => flight.run('k', fn));
    gate.resolve('value');

    await expect(Promise.all(calls)).resolves.toEqual(Array(10).fill('value'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs different keys independently', async () => {
    const flight = new SingleFlight<string>();
    const a = deferred<string>();
    const b = deferred<string>();
    const fnA = vi.fn(() => a.promise);
    const fnB = vi.fn(() => b.promise);

    const pa = flight.run('a', fnA);
    const pb = flight.run('b', fnB);
    b.resolve('B');
    a.resolve('A');

    await expect(pa).resolves.toBe('A');
    await expect(pb).resolves.toBe('B');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('starts a new operation after the previous one succeeded', async () => {
    const flight = new SingleFlight<number>();
    const fn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await expect(flight.run('k', fn)).resolves.toBe(1);
    await expect(flight.run('k', fn)).resolves.toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates a failure to every waiter and does not cache it', async () => {
    const flight = new SingleFlight<string>();
    const gate = deferred<string>();
    const failing = vi.fn(() => gate.promise);

    const waiters = Array.from({ length: 3 }, () => flight.run('k', failing));
    const settled = Promise.allSettled(waiters);
    gate.reject(new Error('boom'));

    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(failing).toHaveBeenCalledTimes(1);

    const retry = vi.fn().mockResolvedValue('ok');
    await expect(flight.run('k', retry)).resolves.toBe('ok');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('treats a synchronous throw as a rejection and releases the key', async () => {
    const flight = new SingleFlight<string>();
    const throwing = (): Promise<string> => {
      throw new Error('sync');
    };

    await expect(flight.run('k', throwing)).rejects.toThrow('sync');
    await expect(flight.run('k', async () => 'after')).resolves.toBe('after');
  });

  it('starts a fresh run for a call made from a continuation after the key settled', async () => {
    const flight = new SingleFlight<number>();
    const fn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const second = flight.run('k', fn).then(() => flight.run('k', fn));

    await expect(second).resolves.toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
