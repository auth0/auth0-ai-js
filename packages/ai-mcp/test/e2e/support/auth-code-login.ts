/**
 * Behavior confirmed against a live tenant (Universal Login, new experience):
 * - Sign in is two pages: an identifier page (`username`, hidden fields), then a password page
 *   (`username`, `password`). Both submit with `action=default`.
 * - With `organization=<org id>` on `/authorize` the organization picker is skipped and the
 *   access token carries `org_id`. A user who is not a member of that organization is sent back to
 *   the callback with `error=access_denied`.
 * - The consent page (`/u/consent`, hidden `state`, `audience`, `scope`, buttons `deny` and
 *   `accept`) appears the first time a user authorizes a client for an API, not on later runs.
 * - `resource` and `audience` together are accepted. The token `aud` lists the API; the granted
 *   scope can be narrower than with `audience` alone.
 * - A rejected password comes back as a 400 page. The helper stops there: submitting again counts
 *   toward brute-force protection and blocks the user.
 *
 * Signs a real user in through Auth0 Universal Login without a browser, using the authorization
 * code flow with PKCE. Unlike the password-realm grant this works for users who sign in through
 * an organization. The helper plays the browser: it follows redirects with a cookie jar, fills in
 * the login, organization and consent forms, catches the code on a loopback listener and
 * exchanges it at the token endpoint.
 *
 * Tokens, codes, cookies, credentials and page bodies are never logged and never appear in error
 * messages. Errors carry the step, the page class and the URL path only.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

export type PageClass = "identifier" | "password" | "login" | "consent" | "org-picker" | "mfa" | "error" | "unknown";

export interface AuthCodeLoginOptions {
  /** Tenant domain such as `example.us.auth0.com` (or a custom domain). No scheme. */
  domain: string;
  clientId: string;
  clientSecret: string;
  /** Loopback port for the callback listener. The client must allow `http://localhost:<port>/callback`. */
  redirectPort: number;
  /** API the token is for. Omit it to rely on `resource` alone. */
  audience?: string;
  scope: string;
  /** Organization id (`org_...`) or name to sign in through. */
  organization?: string;
  username: string;
  password: string;
  /** Sent as the RFC 8707 `resource` parameter when set. */
  resource?: string;
  /** Overall budget for the whole login. Default 60000. */
  timeoutMs?: number;
  /** Budget for one HTTP request. Default 20000. */
  requestTimeoutMs?: number;
  /** Redirects followed before giving up. Default 10. */
  maxHops?: number;
  /** Test seam for the tenant requests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AuthCodeLoginResult {
  accessToken: string;
  idToken?: string;
  expiresIn: number;
  scope: string;
  /** Selected claims of the access token. Safe to log: no token material. */
  claims: SafeClaims;
}

export interface SafeClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  azp?: string;
  org_id?: string;
  scope?: string;
  exp?: number;
}

/** Carries the failing step and, where relevant, the page class and URL path. Never a body. */
export class AuthCodeLoginError extends Error {
  constructor(
    message: string,
    readonly details: { step: string; pageClass?: PageClass; path?: string; status?: number } = { step: "unknown" },
  ) {
    super(message);
    this.name = "AuthCodeLoginError";
  }
}

// ---------------------------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------------------------

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** RFC 7636 S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

// ---------------------------------------------------------------------------------------------
// Form parsing and page classification
// ---------------------------------------------------------------------------------------------

export interface ParsedForm {
  /** Absolute action URL. */
  action: string;
  fields: Record<string, string>;
  buttons: Array<{ name: string; value: string }>;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const key = m[1].toLowerCase();
    if (key in out) continue;
    out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Reads every `<form>` of a page: its action, named inputs and named submit buttons. */
export function parseForms(html: string, pageUrl: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const formAttrs = attrs(m[1]);
    let action: string;
    try {
      action = new URL(formAttrs.action || pageUrl, pageUrl).toString();
    } catch {
      continue;
    }
    const fields: Record<string, string> = {};
    const buttons: Array<{ name: string; value: string }> = [];
    for (const tag of m[2].matchAll(/<(input|button)\b([^>]*)>/gi)) {
      const a = attrs(tag[2]);
      if (!a.name) continue;
      const type = (a.type ?? (tag[1].toLowerCase() === "button" ? "submit" : "text")).toLowerCase();
      if (type === "submit" || type === "button" || type === "image") {
        buttons.push({ name: a.name, value: a.value ?? "" });
      } else if ((type === "checkbox" || type === "radio") && !("checked" in a)) {
        continue;
      } else {
        fields[a.name] = a.value ?? "";
      }
    }
    forms.push({ action, fields, buttons });
  }
  return forms;
}

const hasAccept = (f: ParsedForm) => f.buttons.some((b) => b.name === "action" && /^accept$/i.test(b.value));
const isOrgField = (name: string) => /^org(anization)?(_?(name|id))?$/i.test(name);

/**
 * Which kind of page this is. Decided from the form fields and the URL path, never from copy that
 * changes with the tenant language.
 */
export function classifyPage(
  forms: ParsedForm[],
  path: string,
  html = "",
): { kind: PageClass; form?: ParsedForm } {
  const pick = (pred: (f: ParsedForm) => boolean) => forms.find(pred);
  if (/\/mfa|\/u\/mfa/i.test(path)) return { kind: "mfa", form: forms[0] };
  const withCode = pick((f) => "code" in f.fields && !("password" in f.fields));
  if (withCode) return { kind: "mfa", form: withCode };
  const pw = pick((f) => "password" in f.fields);
  if (pw) return { kind: "username" in pw.fields ? "login" : "password", form: pw };
  const id = pick((f) => "username" in f.fields);
  if (id) return { kind: "identifier", form: id };
  const org = pick((f) => Object.keys(f.fields).some(isOrgField)) ?? (/organization/i.test(path) ? forms[0] : undefined);
  if (org) return { kind: "org-picker", form: org };
  const consent = pick(hasAccept);
  if (consent) return { kind: "consent", form: consent };
  if (!forms.length && /(invalid_request|access_denied|unauthorized_client|invalid_scope|server_error)/i.test(html)) {
    return { kind: "error" };
  }
  return { kind: "unknown" };
}

const KNOWN_ERRORS = /\b(invalid_request|access_denied|unauthorized_client|invalid_scope|invalid_grant|invalid_client|server_error|login_required|consent_required|temporarily_unavailable)\b/i;

/** An OAuth error code from a page or response, if it is one we know. Never free text. */
function knownErrorCode(text: string): string | undefined {
  return KNOWN_ERRORS.exec(text)?.[1]?.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Login driver
// ---------------------------------------------------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_SUBMITS = 6;

function claimsSummary(jwt: string): SafeClaims {
  const part = jwt.split(".")[1];
  if (!part) return {};
  try {
    const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
    const out: SafeClaims = {};
    for (const k of ["sub", "iss", "azp", "org_id", "scope"] as const) if (typeof p[k] === "string") out[k] = p[k];
    if (typeof p.aud === "string" || (Array.isArray(p.aud) && p.aud.every((a) => typeof a === "string"))) {
      out.aud = p.aud as string | string[];
    }
    if (typeof p.exp === "number") out.exp = p.exp;
    return out;
  } catch {
    return {};
  }
}

function startListener(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Signed in. You can close this window.");
    });
    server.once("error", () => reject(new AuthCodeLoginError("callback listener could not bind the redirect port", { step: "listen" })));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export async function loginWithAuthCode(opts: AuthCodeLoginOptions): Promise<AuthCodeLoginResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxHops = opts.maxHops ?? 10;
  const overall = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const requestTimeout = opts.requestTimeoutMs ?? 20_000;
  const base = new URL(`https://${opts.domain}`);
  const redirectUri = `http://localhost:${opts.redirectPort}/callback`;
  const { verifier, challenge } = generatePkce();
  const state = b64url(randomBytes(16));

  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res: Response) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  };
  const send = async (step: string, url: string, init: RequestInit = {}): Promise<Response> => {
    if (new URL(url).host !== base.host) {
      throw new AuthCodeLoginError("refused to send a request off the tenant domain", { step, path: safePath(url) });
    }
    try {
      const res = await doFetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([overall, AbortSignal.timeout(requestTimeout)]),
        ...init,
        headers: { ...(jar.size ? { cookie: cookieHeader() } : {}), ...((init.headers as Record<string, string>) ?? {}) },
      });
      store(res);
      return res;
    } catch (e) {
      if (e instanceof AuthCodeLoginError) throw e;
      const timedOut = overall.aborted || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
      throw new AuthCodeLoginError(timedOut ? "request timed out" : "request failed", { step, path: safePath(url) });
    }
  };

  const authorize = new URL("/authorize", base);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: redirectUri,
    scope: opts.scope,
    ...(opts.audience ? { audience: opts.audience } : {}),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(opts.organization ? { organization: opts.organization } : {}),
    ...(opts.resource ? { resource: opts.resource } : {}),
  }).toString();

  const listener = await startListener(opts.redirectPort);
  try {
    const code = await drive(authorize.toString());
    return await exchange(code);
  } finally {
    listener.close();
    listener.closeAllConnections?.();
  }

  async function drive(startUrl: string): Promise<string> {
    let url = startUrl;
    let method: "GET" | "POST" = "GET";
    let body: string | undefined;
    let hops = 0;
    let submits = 0;
    let retried = false;
    let submittedCredentials = false;
    for (;;) {
      const res = await send("navigate", url, method === "POST" ? { method, body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {});
      if (res.status >= 300 && res.status < 400) {
        if (++hops > maxHops) throw new AuthCodeLoginError("too many redirects", { step: "navigate", path: safePath(url) });
        const loc = res.headers.get("location");
        if (!loc) throw new AuthCodeLoginError("redirect without a location", { step: "navigate", path: safePath(url), status: res.status });
        const next = new URL(loc, url);
        if (LOOPBACK.has(next.hostname)) return await takeCallback(next);
        if (next.host !== base.host) {
          throw new AuthCodeLoginError("refused to follow a redirect off the tenant domain", { step: "navigate", path: safePath(url) });
        }
        url = next.toString();
        method = "GET";
        body = undefined;
        continue;
      }
      const html = await res.text();
      const path = safePath(url);
      // A credentials form that comes back as an error page means the tenant refused the sign-in.
      // Submitting again would only count toward brute-force protection and block the user.
      if (method === "POST" && res.status >= 400 && submittedCredentials) {
        throw new AuthCodeLoginError("the tenant rejected the submitted credentials", {
          step: "credentials",
          pageClass: classifyPage(parseForms(html, url), path, html).kind,
          path,
          status: res.status,
        });
      }
      const { kind, form } = classifyPage(parseForms(html, url), path, html);
      if (kind === "unknown" && !retried && res.status < 500) {
        retried = true;
        method = "GET";
        body = undefined;
        continue;
      }
      if (kind === "error" || kind === "unknown" || kind === "mfa") {
        const code = knownErrorCode(html);
        throw new AuthCodeLoginError(
          `sign-in stopped at ${kind === "mfa" ? "an MFA" : kind === "error" ? "an error" : "an unrecognized"} page${code ? ` (${code})` : ""}`,
          { step: "page", pageClass: kind, path, status: res.status },
        );
      }
      if (!form || ++submits > MAX_SUBMITS) {
        throw new AuthCodeLoginError("too many form submissions", { step: "page", pageClass: kind, path });
      }
      retried = false;
      const fields: Record<string, string> = { ...form.fields };
      if (kind === "identifier" || kind === "login") fields.username = opts.username;
      if (kind === "password" || kind === "login") fields.password = opts.password;
      submittedCredentials = kind === "identifier" || kind === "password" || kind === "login";
      if (kind === "org-picker") {
        if (!opts.organization) throw new AuthCodeLoginError("organization picker shown but no organization was given", { step: "page", pageClass: kind, path });
        for (const k of Object.keys(fields)) if (isOrgField(k)) fields[k] = opts.organization;
      }
      const button =
        kind === "consent"
          ? form.buttons.find((b) => b.name === "action" && /^accept$/i.test(b.value))
          : (form.buttons.find((b) => b.name === "action" && /^default$/i.test(b.value)) ?? form.buttons[0]);
      if (button) fields[button.name] = button.value;
      body = new URLSearchParams(fields).toString();
      url = form.action;
      method = "POST";
    }
  }

  async function takeCallback(cb: URL): Promise<string> {
    if (cb.port !== String(opts.redirectPort) || cb.pathname !== "/callback") {
      throw new AuthCodeLoginError("redirected to an unexpected loopback address", { step: "callback", path: safePath(cb.toString()) });
    }
    const err = cb.searchParams.get("error");
    if (err) {
      throw new AuthCodeLoginError(`authorization failed${knownErrorCode(err) ? ` (${knownErrorCode(err)})` : ""}`, { step: "callback", path: "/callback" });
    }
    if (cb.searchParams.get("state") !== state) {
      throw new AuthCodeLoginError("state mismatch on the callback", { step: "callback", path: "/callback" });
    }
    const code = cb.searchParams.get("code");
    if (!code) throw new AuthCodeLoginError("callback carried no code", { step: "callback", path: "/callback" });
    // Deliver the redirect to the listener like a browser would. Best effort: the code is already in hand.
    await fetch(`http://127.0.0.1:${opts.redirectPort}/callback`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    return code;
  }

  async function exchange(code: string): Promise<AuthCodeLoginResult> {
    const res = await send("token", new URL("/oauth/token", base).toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!res.ok || typeof json.access_token !== "string") {
      const code = typeof json.error === "string" ? knownErrorCode(json.error) : undefined;
      throw new AuthCodeLoginError(`token exchange failed${code ? ` (${code})` : ""}`, { step: "token", path: "/oauth/token", status: res.status });
    }
    return {
      accessToken: json.access_token,
      idToken: typeof json.id_token === "string" ? json.id_token : undefined,
      expiresIn: typeof json.expires_in === "number" ? json.expires_in : 0,
      scope: typeof json.scope === "string" ? json.scope : "",
      claims: claimsSummary(json.access_token),
    };
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
