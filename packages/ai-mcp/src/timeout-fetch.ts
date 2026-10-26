/** Default limit, in milliseconds, for each outbound HTTP request of the core client. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Largest delay `setTimeout` accepts. A larger value would fire immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Returns `value` when it is a usable timeout, otherwise throws a `RangeError`.
 * A usable timeout is a finite number greater than zero and at most 2,147,483,647.
 */
export function assertValidTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError('must be a finite number greater than 0 and at most 2147483647');
  }
  return value;
}

/**
 * Wraps `fetch` so each request is aborted after `timeoutMs`.
 *
 * The abort cancels the network call itself, so nothing is left running. The limit covers
 * the whole exchange, response body included: the timer keeps running after the headers
 * arrive and is cleared when the body is read to the end, cancelled or fails. A response
 * whose body is never consumed keeps its timer until it fires. The timer is unref'd, so it
 * never holds a process open. Signals from the caller (`init.signal`, and the signal of a
 * `Request` passed as `input`) are honoured as well, and their listeners are removed with
 * the timer. `globalThis.fetch` is read on every call, so test doubles installed later
 * still apply.
 */
export function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const upstreams: AbortSignal[] = [];
    if (init?.signal) upstreams.push(init.signal);
    if (typeof Request !== 'undefined' && input instanceof Request) upstreams.push(input.signal);

    const listeners: Array<[AbortSignal, () => void]> = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    };

    for (const upstream of upstreams) {
      if (upstream.aborted) {
        controller.abort(upstream.reason);
        continue;
      }
      const listener = () => controller.abort(upstream.reason);
      upstream.addEventListener('abort', listener, { once: true });
      listeners.push([upstream, listener]);
    }

    const timer = setTimeout(() => {
      release();
      controller.abort(new DOMException(`The request timed out after ${timeoutMs} ms.`, 'TimeoutError'));
    }, timeoutMs);
    timer.unref?.();

    return globalThis
      .fetch(input, { ...init, signal: controller.signal })
      .then((response) => (response.body ? withReleaseOnSettle(response, release) : (release(), response)))
      .catch((error: unknown) => {
        release();
        throw error;
      });
  };
}

/**
 * Returns a copy of `response` whose body calls `release` once it ends, errors or is
 * cancelled. Status, headers and url carry over.
 */
function withReleaseOnSettle(response: Response, release: () => void): Response {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          stream.close();
        } else {
          stream.enqueue(value);
        }
      } catch (error) {
        release();
        stream.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(wrapped, 'url', { value: response.url });
  return wrapped;
}
