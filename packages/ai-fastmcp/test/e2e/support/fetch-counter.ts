/**
 * Counts POSTs to `/oauth/token` by `grant_type`, and lists every request, by wrapping
 * `globalThis.fetch`. The core client accepts no custom fetch, so the global is the only seam.
 * Install it before the calls to observe and call `restore()` in `afterEach`. Mint tokens outside
 * the window, so retries of the token helpers never move a count.
 */

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

export interface FetchCounter {
  /** Count of token endpoint POSTs for one grant type. */
  count(grantType: string): number;
  /** Count of token exchange POSTs. */
  readonly exchanges: number;
  /** All counted grant types and their counts. */
  readonly byGrant: Readonly<Record<string, number>>;
  /** Every request seen, as `METHOD origin+path`, in order. Query strings and bodies are not kept. */
  readonly requests: string[];
  /** Zeroes the counts and forgets the requests. */
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
  const requests: string[] = [];
  let installed = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { grantType: grant, url, method } = await describeRequest(input, init);
    if (grant !== null) byGrant[grant] = (byGrant[grant] ?? 0) + 1;
    requests.push(`${method} ${url.origin}${url.pathname}`);
    return original(input, init);
  }) as typeof fetch;
  const wrapper = globalThis.fetch;

  return {
    count: (grantType) => byGrant[grantType] ?? 0,
    get exchanges() {
      return byGrant[TOKEN_EXCHANGE_GRANT] ?? 0;
    },
    byGrant,
    requests,
    reset() {
      for (const key of Object.keys(byGrant)) delete byGrant[key];
      requests.length = 0;
    },
    restore() {
      if (installed && globalThis.fetch === wrapper) globalThis.fetch = original;
      installed = false;
    },
  };
}
