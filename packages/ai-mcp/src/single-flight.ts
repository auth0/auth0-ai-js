/**
 * Collapses concurrent calls that share a key into one in-flight operation.
 *
 * The first caller for a key starts the operation. Every caller that arrives with the same
 * key before it settles receives the same promise, so the operation runs once. When it
 * settles, successfully or not, the key is released: a failure reaches every waiter but is
 * never remembered, and the next call for that key starts a fresh operation.
 *
 * Calls with different keys never wait on each other. The key is the only isolation between
 * callers, so it must include everything that identifies the result: for a token, that means
 * the principal, tenant, audience and scopes. Two callers who should not share a token must
 * never share a key. The operation passed to `run` must not call `run` again with the same
 * key while it is in flight, because it would wait on itself.
 */
export class SingleFlight<T> {
  readonly #inFlight = new Map<string, Promise<T>>();

  /**
   * Runs `fn` unless an operation for `key` is already in flight, in which case the
   * in-flight promise is returned instead.
   *
   * @param key - Identifies operations that may share a result.
   * @param fn - The operation. A synchronous throw is treated as a rejection.
   * @returns The result of the shared operation.
   */
  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const promise = (async () => fn())().finally(() => {
      if (this.#inFlight.get(key) === promise) {
        this.#inFlight.delete(key);
      }
    });

    this.#inFlight.set(key, promise);

    return promise;
  }
}
