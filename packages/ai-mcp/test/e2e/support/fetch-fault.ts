/**
 * Injects failures into `globalThis.fetch` for matching requests. The core client accepts no
 * custom fetch through `createMcpClient`, so the global is the only seam.
 *
 * Install it before the server under test makes its first call to the faulted endpoint. The core
 * client resolves the global `fetch` for the JWKS set once, when it first verifies a token, and
 * caches discovery metadata and the JWKS set per client. Use a fresh server per fault case.
 *
 * Composition with `installFetchCounter`: the later install is the outer wrapper. Install the
 * counter after the fault to count every attempt including faulted ones; install it before the
 * fault to count only requests that reach the network. Restore in reverse order (LIFO). A wrapper
 * restored out of order becomes a pass-through instead of corrupting the chain.
 */
import { describeRequest } from "./fetch-counter.js";
import type { FetchCallInfo } from "./fetch-counter.js";

/** All given fields must match. An empty match matches every request. */
export interface FetchMatch {
  /** Substring of the full URL. */
  urlIncludes?: string;
  /** Case-insensitive HTTP method. */
  method?: string;
  /** Matches token endpoint POSTs with this `grant_type`. */
  grantType?: string;
  /** Custom predicate, run after the other fields. */
  predicate?: (call: FetchCallInfo) => boolean;
}

export type FetchFault =
  /** Answers with this status and a JSON body (or a raw string body) without calling the network. */
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  /** Rejects with `TypeError("fetch failed")`, like undici on a refused or reset connection. */
  | { kind: "network"; message?: string }
  /** Waits, then passes the request through to the next fetch. */
  | { kind: "delay"; ms: number };

export interface FetchFaultOptions {
  /** Inject for this many matching requests, then pass through. Default: every matching request. */
  times?: number;
}

export interface FetchFaultHandle {
  /** Number of requests that matched and were faulted so far. */
  readonly injected: number;
  /** Puts the previous `fetch` back. Safe to call twice. */
  restore(): void;
}

function matches(match: FetchMatch, call: FetchCallInfo): boolean {
  if (match.urlIncludes !== undefined && !call.url.href.includes(match.urlIncludes)) return false;
  if (match.method !== undefined && call.method !== match.method.toUpperCase()) return false;
  if (match.grantType !== undefined && call.grantType !== match.grantType) return false;
  return match.predicate?.(call) ?? true;
}

/**
 * Waits `ms`, or rejects with the signal's reason as soon as the caller aborts, like a real
 * network wait would. This lets a request timeout cut a delayed request short.
 */
function delayUnlessAborted(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wraps `globalThis.fetch` with a fault for matching requests. */
export function installFetchFault(
  match: FetchMatch,
  fault: FetchFault,
  options: FetchFaultOptions = {},
): FetchFaultHandle {
  const previous = globalThis.fetch;
  let remaining = options.times ?? Number.POSITIVE_INFINITY;
  let injected = 0;
  let active = true;

  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (active && remaining > 0) {
      const call = await describeRequest(input, init);
      if (matches(match, call)) {
        remaining -= 1;
        injected += 1;
        if (fault.kind === "network") throw new TypeError(fault.message ?? "fetch failed");
        if (fault.kind === "delay") {
          await delayUnlessAborted(fault.ms, init?.signal ?? (input instanceof Request ? input.signal : undefined));
        } else {
          const body = typeof fault.body === "string" ? fault.body : JSON.stringify(fault.body ?? {});
          return new Response(body, {
            status: fault.status,
            headers: { "content-type": "application/json", ...fault.headers },
          });
        }
      }
    }
    return previous(input, init);
  }) as typeof fetch;
  globalThis.fetch = wrapper;

  return {
    get injected() {
      return injected;
    },
    restore() {
      active = false;
      if (globalThis.fetch === wrapper) globalThis.fetch = previous;
    },
  };
}
