import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertValidTimeout, createTimeoutFetch } from '../src/timeout-fetch.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fetch that never answers and rejects when its signal aborts. */
function hangingFetch() {
  const seen: AbortSignal[] = [];
  const impl = vi.fn((_input: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    seen.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', impl);
  return { impl, seen };
}

describe('createTimeoutFetch', () => {
  it('aborts the underlying request with a TimeoutError once the limit passes', async () => {
    vi.useFakeTimers();
    const { seen } = hangingFetch();
    const pending = createTimeoutFetch(1000)('https://tenant.example.com/oauth/token');
    const outcome = pending.then(
      () => undefined,
      (error: Error) => error
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(seen[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(seen[0]?.aborted).toBe(true);
    expect(error?.name).toBe('TimeoutError');
  });

  it('passes a response through when it arrives in time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    const response = await createTimeoutFetch(1000)('https://tenant.example.com/x');
    expect(await response.text()).toBe('ok');
  });

  it('forwards the request init apart from the signal', async () => {
    const impl = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', impl);
    await createTimeoutFetch(1000)('https://tenant.example.com/x', { method: 'POST', body: 'a=b' });
    const init = (impl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('a=b');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours a caller supplied signal', async () => {
    const { seen } = hangingFetch();
    const caller = new AbortController();
    const pending = createTimeoutFetch(60_000)('https://tenant.example.com/x', { signal: caller.signal });
    caller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toThrow('caller gave up');
    expect(seen[0]?.aborted).toBe(true);
  });

  it('aborts at once when the caller signal is already aborted', async () => {
    hangingFetch();
    const caller = new AbortController();
    caller.abort(new Error('already'));
    await expect(createTimeoutFetch(60_000)('https://tenant.example.com/x', { signal: caller.signal })).rejects.toThrow(
      'already'
    );
  });
});

describe('createTimeoutFetch body handling', () => {
  /** A response whose body yields one chunk and then stays open until `finish` is called. */
  function openBody() {
    let finish!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abc'));
        finish = () => controller.close();
      },
    });
    return { response: new Response(stream, { status: 201, statusText: 'Made', headers: { 'x-a': 'b' } }), finish };
  }

  it('clears the timer once the body has been read to the end', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello')));
    const response = await createTimeoutFetch(1000)('https://tenant.example.com/x');
    expect(vi.getTimerCount()).toBe(1);
    expect(await response.text()).toBe('hello');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps status, headers and url on the returned response', async () => {
    const { response, finish } = openBody();
    Object.defineProperty(response, 'url', { value: 'https://tenant.example.com/x' });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const out = await createTimeoutFetch(1000)('https://tenant.example.com/x');
    expect([out.status, out.statusText, out.headers.get('x-a'), out.url]).toEqual([
      201,
      'Made',
      'b',
      'https://tenant.example.com/x',
    ]);
    finish();
    expect(await out.text()).toBe('abc');
  });

  it('clears the timer when the body is cancelled', async () => {
    vi.useFakeTimers();
    const { response } = openBody();
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const out = await createTimeoutFetch(1000)('https://tenant.example.com/x');
    expect(vi.getTimerCount()).toBe(1);
    await out.body?.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer when the body errors', async () => {
    vi.useFakeTimers();
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(failing)));
    const out = await createTimeoutFetch(1000)('https://tenant.example.com/x');
    await expect(out.text()).rejects.toThrow('socket reset');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still bounds a body that stalls after the headers arrive', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
            },
          })
        );
      })
    );
    const out = await createTimeoutFetch(1000)('https://tenant.example.com/x');
    const outcome = out.text().then(
      () => undefined,
      (error: Error) => error
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((await outcome)?.name).toBe('TimeoutError');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the caller signal listener when the body ends', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x')));
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, 'addEventListener');
    const removed = vi.spyOn(caller.signal, 'removeEventListener');
    const response = await createTimeoutFetch(1000)('https://tenant.example.com/x', { signal: caller.signal });
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    await response.text();
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('clears the timer and listener for a response without a body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, 'removeEventListener');
    const out = await createTimeoutFetch(1000)('https://tenant.example.com/x', { signal: caller.signal });
    expect(out.status).toBe(204);
    expect(vi.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('honours the signal of a Request passed as input', async () => {
    const { seen } = hangingFetch();
    const caller = new AbortController();
    const request = new Request('https://tenant.example.com/x', { signal: caller.signal });
    const pending = createTimeoutFetch(60_000)(request);
    caller.abort(new Error('request cancelled'));
    await expect(pending).rejects.toThrow('request cancelled');
    expect(seen[0]?.aborted).toBe(true);
  });

  it('honours both the Request signal and init.signal', async () => {
    const { seen } = hangingFetch();
    const fromRequest = new AbortController();
    const fromInit = new AbortController();
    const request = new Request('https://tenant.example.com/x', { signal: fromRequest.signal });
    const pending = createTimeoutFetch(60_000)(request, { signal: fromInit.signal });
    fromInit.abort(new Error('init cancelled'));
    await expect(pending).rejects.toThrow('init cancelled');
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe('assertValidTimeout', () => {
  it.each([1, 10_000, 2_147_483_647, 0.5])('accepts %s', (value) => {
    expect(assertValidTimeout(value)).toBe(value);
  });

  it.each([0, -1, Number.NaN, Infinity, 2_147_483_648, '1000', null, undefined, {}])('rejects %s', (value) => {
    expect(() => assertValidTimeout(value)).toThrow(RangeError);
  });
});
