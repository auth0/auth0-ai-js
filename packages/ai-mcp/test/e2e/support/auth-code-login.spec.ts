/**
 * Offline tests for the authorization code login helper. A scripted fake tenant answers through
 * the `fetchImpl` seam with synthetic Universal Login pages. Nothing here touches the network
 * except a loopback listener on this machine.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuthCodeLoginError,
  classifyPage,
  loginWithAuthCode,
  parseForms,
  pkceChallenge,
} from "./auth-code-login.js";
import type { AuthCodeLoginOptions } from "./auth-code-login.js";

const dir = dirname(fileURLToPath(import.meta.url));
const page = (name: string) => readFileSync(join(dir, "fixtures", "html", name), "utf8");
const DOMAIN = "tenant.example.test";
const BASE = `https://${DOMAIN}`;
const PASSWORD = "S3cret-pw-for-tests";
const CODE = "SYNTH-CODE-123";
const PLANTED = "PLANTED-SECRET-VALUE";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const html = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...extra } });
const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { location: to, ...headers } });

interface Seen {
  url: URL;
  method: string;
  cookie: string | null;
  body: URLSearchParams;
}

/** A tenant that signs in through identifier, password, optional organization and consent pages. */
function fakeTenant(
  port: number,
  cfg: { org?: boolean; consent?: boolean; callbackState?: (s: string) => string; tokenBody?: unknown; tokenStatus?: number } = {},
) {
  const seen: Seen[] = [];
  let authorize: URLSearchParams | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, method: init?.method ?? "GET", cookie: headers.cookie ?? null, body });
    const resume = () => redirect(`/authorize/resume?state=r`);
    switch (url.pathname) {
      case "/authorize":
        authorize = url.searchParams;
        return redirect("/u/login/identifier?state=S", { "set-cookie": "did=abc123; Path=/; HttpOnly" });
      case "/u/login/identifier":
        return init?.method === "POST" ? redirect("/u/login/password?state=S") : html(page("identifier-new.html"));
      case "/u/login/password":
        return init?.method === "POST" ? resume() : html(page("password-new.html"));
      case "/u/organization-picker":
        return init?.method === "POST" ? resume() : html(page("org-picker.html"));
      case "/u/consent":
        return init?.method === "POST" ? resume() : html(page("consent.html"));
      case "/authorize/resume": {
        const n = seen.filter((s) => s.url.pathname === "/authorize/resume").length;
        if (cfg.org && n === 1) return redirect("/u/organization-picker?state=S");
        if (cfg.consent && n === (cfg.org ? 2 : 1)) return redirect("/u/consent?state=S");
        const state = cfg.callbackState ? cfg.callbackState(authorize!.get("state")!) : authorize!.get("state")!;
        return redirect(`http://localhost:${port}/callback?code=${CODE}&state=${state}`);
      }
      case "/oauth/token": {
        const p = body;
        const ok =
          p.get("grant_type") === "authorization_code" &&
          p.get("code") === CODE &&
          pkceChallenge(p.get("code_verifier") ?? "") === authorize!.get("code_challenge") &&
          p.get("redirect_uri") === `http://localhost:${port}/callback`;
        const payload = Buffer.from(JSON.stringify({ sub: "auth0|u1", iss: `${BASE}/`, aud: ["https://api.test"], org_id: authorize!.get("organization"), scope: "read:x", secretish: "no" })).toString("base64url");
        return new Response(
          JSON.stringify(
            cfg.tokenBody ?? (ok ? { access_token: `h.${payload}.s`, id_token: "i.d.t", expires_in: 3600, scope: "read:x" } : { error: "invalid_grant", error_description: PLANTED }),
          ),
          { status: cfg.tokenStatus ?? (ok ? 200 : 403), headers: { "content-type": "application/json" } },
        );
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen, authorize: () => authorize };
}

async function options(over: Partial<AuthCodeLoginOptions> = {}): Promise<AuthCodeLoginOptions> {
  return {
    domain: DOMAIN,
    clientId: "client-1",
    clientSecret: "client-secret-for-tests",
    redirectPort: await freePort(),
    audience: "https://api.test",
    scope: "openid read:x",
    username: "user@example.test",
    password: PASSWORD,
    ...over,
  };
}

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("sends an S256 challenge whose verifier the token request later proves", async () => {
    const o = await options();
    const t = fakeTenant(o.redirectPort);
    await loginWithAuthCode({ ...o, fetchImpl: t.fetchImpl });
    const a = t.authorize()!;
    expect(a.get("code_challenge_method")).toBe("S256");
    const tokenReq = t.seen.find((s) => s.url.pathname === "/oauth/token")!;
    const verifier = tokenReq.body.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(a.get("code_challenge"));
  });
});

describe("form parsing and classification", () => {
  const url = `${BASE}/u/login/identifier?state=S`;
  const classify = (name: string, path = "/u/login/identifier") => classifyPage(parseForms(page(name), `${BASE}${path}`), path, page(name));

  it("reads action, hidden fields and the default button of the new identifier page", () => {
    const [form] = parseForms(page("identifier-new.html"), url);
    expect(form.action).toBe(`${BASE}/u/login/identifier?state=SYNTH_STATE`);
    expect(form.fields).toMatchObject({ state: "SYNTH_STATE", username: "" });
    expect(form.buttons).toContainEqual({ name: "action", value: "default" });
  });

  it("classifies each page class", () => {
    expect(classify("identifier-new.html").kind).toBe("identifier");
    expect(classify("password-new.html", "/u/login/password").kind).toBe("login");
    expect(classify("login-old.html", "/login").kind).toBe("login");
    expect(classify("consent.html", "/u/consent").kind).toBe("consent");
    expect(classify("org-picker.html", "/u/organization-picker").kind).toBe("org-picker");
    expect(classify("mfa.html", "/u/mfa-otp-challenge").kind).toBe("mfa");
    expect(classify("error.html", "/error").kind).toBe("error");
    expect(classify("blank.html", "/x").kind).toBe("unknown");
  });

  it("handles single-quoted attributes and skips unchecked checkboxes on the old form", () => {
    const [form] = parseForms(page("login-old.html"), `${BASE}/login`);
    expect(Object.keys(form.fields).sort()).toEqual(["password", "state", "username"]);
  });

  it("picks the login form, not the social form, when a page has both", () => {
    expect(classify("identifier-new.html").form?.fields).toHaveProperty("username");
  });
});

describe("login flow", () => {
  it("signs in through identifier and password and returns safe claims", async () => {
    const o = await options();
    const t = fakeTenant(o.redirectPort);
    const r = await loginWithAuthCode({ ...o, fetchImpl: t.fetchImpl });
    expect(r.expiresIn).toBe(3600);
    expect(r.scope).toBe("read:x");
    expect(r.claims).toEqual({ sub: "auth0|u1", iss: `${BASE}/`, aud: ["https://api.test"], scope: "read:x" });
    const submitted = t.seen.filter((s) => s.method === "POST" && s.url.pathname.startsWith("/u/login"));
    expect(submitted.map((s) => s.body.get("username"))).toEqual(["user@example.test", "user@example.test"]);
    expect(submitted[1].body.get("password")).toBe(PASSWORD);
    expect(submitted[0].body.get("action")).toBe("default");
  });

  it("carries the cookie set at authorize to later requests and never sends it elsewhere", async () => {
    const o = await options();
    const t = fakeTenant(o.redirectPort);
    await loginWithAuthCode({ ...o, fetchImpl: t.fetchImpl });
    expect(t.seen[0].cookie).toBeNull();
    for (const s of t.seen.slice(1)) expect(s.cookie).toContain("did=abc123");
  });

  it("passes organization and resource on the authorize request and signs in through the picker", async () => {
    const o = await options({ organization: "org_abc", resource: "https://mcp.test" });
    const t = fakeTenant(o.redirectPort, { org: true });
    const r = await loginWithAuthCode({ ...o, fetchImpl: t.fetchImpl });
    const a = t.authorize()!;
    expect(a.get("organization")).toBe("org_abc");
    expect(a.get("resource")).toBe("https://mcp.test");
    expect(a.get("audience")).toBe("https://api.test");
    const picker = t.seen.find((s) => s.method === "POST" && s.url.pathname === "/u/organization-picker")!;
    expect(picker.body.get("organization")).toBe("org_abc");
    expect(r.claims.org_id).toBe("org_abc");
  });

  it("accepts the consent page", async () => {
    const o = await options();
    const t = fakeTenant(o.redirectPort, { consent: true });
    await loginWithAuthCode({ ...o, fetchImpl: t.fetchImpl });
    const decision = t.seen.find((s) => s.url.pathname === "/u/consent" && s.method === "POST")!;
    expect(decision.body.get("audience")).toBe("https://api.test");
    expect(decision.body.get("action")).toBe("accept");
  });

  it("stops at the first rejected credentials instead of resubmitting them", async () => {
    const o = await options();
    const t = fakeTenant(o.redirectPort);
    const rejecting = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/u/login/password" && init?.method === "POST") {
        t.seen.push({ url: new URL(String(input)), method: "POST", cookie: null, body: new URLSearchParams() });
        return new Response(page("login-rejected.html"), { status: 400, headers: { "content-type": "text/html" } });
      }
      return t.fetchImpl(input, init);
    }) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl: rejecting })).rejects.toMatchObject({
      details: { step: "credentials", pageClass: "login", status: 400 },
    });
    expect(t.seen.filter((s) => s.method === "POST" && s.url.pathname === "/u/login/password")).toHaveLength(1);
  });

  it("rejects a callback with a mismatched state", async () => {
    const o = await options();
    const t = fakeTenant(o.redirectPort, { callbackState: () => "forged" });
    await expect(loginWithAuthCode({ ...o, fetchImpl: t.fetchImpl })).rejects.toThrow(/state mismatch/);
    expect(t.seen.some((s) => s.url.pathname === "/oauth/token")).toBe(false);
  });

  it("refuses a redirect off the tenant domain without following it", async () => {
    const o = await options();
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return redirect("https://evil.example.net/steal?code=1");
    }) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl })).rejects.toThrow(/off the tenant domain/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a loopback redirect to another port or path", async () => {
    const o = await options();
    const fetchImpl = (async () => redirect(`http://localhost:${o.redirectPort + 1}/callback?code=x&state=y`)) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl })).rejects.toThrow(/unexpected loopback/);
  });

  it("stops after the hop limit", async () => {
    const o = await options({ maxHops: 3 });
    const fetchImpl = (async () => redirect("/loop")) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl })).rejects.toThrow(/too many redirects/);
  });

  it("enforces the overall timeout when the tenant never answers", async () => {
    const o = await options({ timeoutMs: 100, requestTimeoutMs: 5000 });
    const fetchImpl = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const started = Date.now();
    await expect(loginWithAuthCode({ ...o, fetchImpl })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("retries an unrecognized page once and then gives up", async () => {
    const o = await options();
    let n = 0;
    const fetchImpl = (async () => (n++ === 0 ? redirect("/u/x") : html(page("blank.html")))) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl })).rejects.toMatchObject({ details: { pageClass: "unknown", path: "/u/x" } });
    expect(n).toBe(3);
  });

  it("recovers when the retry of an unrecognized page succeeds", async () => {
    const o = await options();
    const t = fakeTenant(o.redirectPort);
    let first = true;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (first && new URL(String(input)).pathname === "/u/login/identifier") {
        first = false;
        return html(page("blank.html"));
      }
      return t.fetchImpl(input, init);
    }) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl: flaky })).resolves.toMatchObject({ expiresIn: 3600 });
  });

  it("fails on an MFA page and names the page class", async () => {
    const o = await options();
    const fetchImpl = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === "/authorize" ? redirect("/u/mfa-otp-challenge?state=S") : html(page("mfa.html"))) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl })).rejects.toMatchObject({ details: { pageClass: "mfa", path: "/u/mfa-otp-challenge" } });
  });

  it("fails when an organization picker appears and no organization was requested", async () => {
    const o = await options();
    const fetchImpl = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === "/authorize" ? redirect("/u/organization-picker?state=S") : html(page("org-picker.html"))) as typeof fetch;
    await expect(loginWithAuthCode({ ...o, fetchImpl })).rejects.toThrow(/no organization was given/);
  });
});

describe("errors leak nothing", () => {
  async function failure(run: (o: AuthCodeLoginOptions) => Promise<unknown>): Promise<AuthCodeLoginError> {
    const o = await options();
    const err = await run(o).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthCodeLoginError);
    return err as AuthCodeLoginError;
  }
  const forbidden = [PASSWORD, "client-secret-for-tests", CODE, PLANTED, "did=abc123", "SYNTH_STATE"];
  const everything = (e: AuthCodeLoginError) => `${e.message} ${JSON.stringify(e.details)} ${e.stack ?? ""}`;

  it("keeps page content out of an error page failure", async () => {
    const e = await failure((o) =>
      loginWithAuthCode({ ...o, fetchImpl: (async () => html(page("error.html"), { "set-cookie": "did=abc123; Path=/" })) as typeof fetch }),
    );
    expect(e.message).toContain("invalid_request");
    for (const f of forbidden) expect(everything(e)).not.toContain(f);
  });

  it("keeps the token endpoint body, code and secrets out of an exchange failure", async () => {
    const e = await failure(async (o) => {
      const t = fakeTenant(o.redirectPort, { tokenStatus: 403, tokenBody: { error: "invalid_grant", error_description: `${PLANTED} ${CODE} ${PASSWORD}` } });
      return loginWithAuthCode({ ...o, fetchImpl: t.fetchImpl });
    });
    expect(e.message).toBe("token exchange failed (invalid_grant)");
    expect(e.details.status).toBe(403);
    for (const f of forbidden) expect(everything(e)).not.toContain(f);
  });

  it("keeps free text from an authorization error redirect out of the message", async () => {
    const e = await failure((o) =>
      loginWithAuthCode({
        ...o,
        fetchImpl: (async () =>
          redirect(`http://localhost:${o.redirectPort}/callback?error=access_denied&error_description=${PLANTED}`)) as typeof fetch,
      }),
    );
    expect(e.message).toBe("authorization failed (access_denied)");
    expect(everything(e)).not.toContain(PLANTED);
  });

  it("keeps a network error message out of the failure", async () => {
    const e = await failure((o) =>
      loginWithAuthCode({ ...o, fetchImpl: (async () => { throw new TypeError(`connect failed for ${PASSWORD}`); }) as typeof fetch }),
    );
    expect(e.message).toBe("request failed");
    expect(everything(e)).not.toContain(PASSWORD);
  });
});
