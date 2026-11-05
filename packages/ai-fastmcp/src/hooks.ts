/**
 * Calls an observer hook with an error and never lets the hook change the outcome: a hook that
 * throws, or returns a promise that rejects, is ignored. Without a hook it does nothing.
 */
export function safely(hook: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    const result: unknown = hook?.(error);
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
      (result as PromiseLike<unknown>).then(undefined, () => {});
    }
  } catch {
    // A failing observer must not change the outcome.
  }
}
