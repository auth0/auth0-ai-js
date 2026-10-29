/**
 * Counts POSTs to `/oauth/token` by `grant_type` by wrapping `globalThis.fetch`. The core client
 * accepts no custom fetch, so the global is the only seam. Install it before creating the server
 * under test and call `restore()` in `afterEach`.
 *
 * Ordering with `installFetchFault`: the later install is the outer wrapper. Install the counter
 * AFTER the fault to count every attempt, including faulted ones. Install it BEFORE the fault to
 * count only requests that reach the network. Restore in reverse order of installation.
 */

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

export interface FetchCounter {
  /** Count of token endpoint POSTs for one grant type. */
  count(grantType: string): number;
  /** Count of token exchange POSTs. */
  readonly exchanges: number;
  /** All counted grant types and their counts. */
  readonly byGrant: Readonly<Record<string, number>>;
  /** Zeroes the counts. */
  reset(): void;
  /** Puts the original `fetch` back. Safe to call twice. */
  restore(): void;
}

/** What a fetch call asked for, as far as the e2e helpers need to know. */
export interface FetchCallInfo {
  url: URL;
  method: string;
  /** Form `grant_type` of a token endpoint POST (`"unknown"` when absent), else null. */
  grantType: string | null;
}

/** Reads URL, method and (for `/oauth/token` POSTs) the grant type of a fetch call. */
export async function describeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<FetchCallInfo> {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? (input instanceof URL ? input.href : String(input)));
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  if (method !== "POST" || !url.pathname.endsWith("/oauth/token")) return { url, method, grantType: null };
  const body = init?.body ?? (request ? await request.clone().text() : undefined);
  let grantType = "unknown";
  if (body instanceof URLSearchParams) grantType = body.get("grant_type") ?? "unknown";
  else if (typeof body === "string") grantType = new URLSearchParams(body).get("grant_type") ?? "unknown";
  return { url, method, grantType };
}

/** Wraps `globalThis.fetch` and starts counting. */
export function installFetchCounter(): FetchCounter {
  const original = globalThis.fetch;
  const byGrant: Record<string, number> = {};
  let installed = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { grantType: grant } = await describeRequest(input, init);
    if (grant !== null) byGrant[grant] = (byGrant[grant] ?? 0) + 1;
    return original(input, init);
  }) as typeof fetch;
  const wrapper = globalThis.fetch;

  return {
    count: (grantType) => byGrant[grantType] ?? 0,
    get exchanges() {
      return byGrant[TOKEN_EXCHANGE_GRANT] ?? 0;
    },
    byGrant,
    reset() {
      for (const key of Object.keys(byGrant)) delete byGrant[key];
    },
    restore() {
      if (installed && globalThis.fetch === wrapper) globalThis.fetch = original;
      installed = false;
    },
  };
}
