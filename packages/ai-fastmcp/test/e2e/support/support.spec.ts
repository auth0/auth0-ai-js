/**
 * Hermetic checks of the e2e helpers and the runner. They need no tenant and run with the normal
 * unit suite, so a broken helper is found before a live run is attempted.
 */
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import defaultConfig from "../../../vitest.config.js";
import e2eConfig from "../../../vitest.e2e.config.js";
import slowConfig from "../../../vitest.e2e.slow.config.js";
// @ts-expect-error The runner scripts are plain JavaScript without type declarations.
import * as lib from "../../../scripts/e2e/lib.mjs";
// @ts-expect-error The runner scripts are plain JavaScript without type declarations.
import * as preflight from "../../../scripts/e2e/preflight.mjs";
import {
  TOKEN_EXCHANGE_GRANT,
  backoffDelayMs,
  expectNoTokens,
  fragmentsOf,
  headerOnly,
  installFetchCounter,
  loopbackPort,
  parseChallenge,
  postInitialize,
  postTokenRequest,
  readE2eSettings,
  signedByAttacker,
  startFastMcpServer,
  withAlgNone,
  withTamperedPayload,
} from "./index.js";
import type { E2eEnv } from "./index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

function jwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part(header)}.${part(payload)}.${Buffer.from("signature-bytes-of-the-token").toString("base64url")}`;
}

const REAL_LOOKING = jwt({ iss: "https://tenant.example.com/", aud: "http://127.0.0.1:3000/mcp", sub: "user|1", scope: "a b", exp: 4_000_000_000 });

describe("the default unit run", () => {
  it("excludes the real-tenant specs of both tiers, and each tier config includes only its own", () => {
    const exclude = defaultConfig.test?.exclude ?? [];
    expect(exclude).toContain("test/e2e/**/*.e2e.spec.ts");
    expect(exclude).toContain("test/e2e/**/*.e2e.slow.spec.ts");
    expect(e2eConfig.test?.include).toEqual(["test/e2e/**/*.e2e.spec.ts"]);
    expect(slowConfig.test?.include).toEqual(["test/e2e/slow/**/*.e2e.slow.spec.ts"]);
    expect(e2eConfig.test?.fileParallelism).toBe(false);
    expect(slowConfig.test?.fileParallelism).toBe(false);
  });
});

describe("readE2eSettings", () => {
  const names = [
    "AUTH0_E2E_DOMAIN",
    "AUTH0_E2E_MCP_AUDIENCE",
    "AUTH0_E2E_DOWNSTREAM_AUDIENCE",
    "AUTH0_E2E_OBO_CLIENT_ID",
    "AUTH0_E2E_OBO_CLIENT_SECRET",
    "AUTH0_E2E_LOGIN_CLIENT_ID",
    "AUTH0_E2E_LOGIN_CLIENT_SECRET",
    "AUTH0_E2E_USERNAME",
    "AUTH0_E2E_PASSWORD",
    "AUTH0_E2E_REALM",
  ];

  it("is not ready, and names the missing variables but no value, when settings are absent", () => {
    for (const name of names) vi.stubEnv(name, "");
    const settings = readE2eSettings();
    expect(settings.ready).toBe(false);
    expect(settings.missing).toEqual(names);
  });

  it("is ready when every base variable is set, and reports the extra ones that are not", () => {
    for (const name of names) vi.stubEnv(name, `value-of-${name}`);
    vi.stubEnv("AUTH0_E2E_SHORT_LIFETIME_SECONDS", "");
    expect(readE2eSettings().ready).toBe(true);
    const withExtra = readE2eSettings(["AUTH0_E2E_SHORT_LIFETIME_SECONDS"]);
    expect(withExtra.ready).toBe(false);
    expect(withExtra.missing).toEqual(["AUTH0_E2E_SHORT_LIFETIME_SECONDS"]);
    expect(withExtra.env.issuer).toBe("https://value-of-AUTH0_E2E_DOMAIN/");
    expect(withExtra.env.downstreamScope).toBe("work:read");
  });
});

describe("token helpers", () => {
  it("backs off by the server's hint, within bounds, and exponentially without one", () => {
    expect(backoffDelayMs(0, new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(backoffDelayMs(0, new Headers({ "retry-after": "0" }))).toBe(250);
    expect(backoffDelayMs(0, new Headers({ "retry-after": "9999" }))).toBe(30_000);
    const now = 1_000_000;
    expect(backoffDelayMs(0, new Headers({ "x-ratelimit-reset": String((now + 3000) / 1000) }), now)).toBe(3000);
    const first = backoffDelayMs(0, new Headers());
    const third = backoffDelayMs(2, new Headers());
    expect(first).toBeGreaterThanOrEqual(750);
    expect(first).toBeLessThanOrEqual(1250);
    expect(third).toBeGreaterThanOrEqual(3000);
  });

  it("retries a 429 and returns the next answer; returns a 4xx as it is", async () => {
    const answers = [
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      new Response(JSON.stringify({ access_token: "t" }), { status: 200 }),
    ];
    globalThis.fetch = vi.fn(async () => answers.shift()!) as unknown as typeof fetch;
    const retried = await postTokenRequest({ domain: "tenant.test" }, { grant_type: "client_credentials" });
    expect(retried).toEqual({ status: 200, body: { access_token: "t" } });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "access_denied" }), { status: 403 })) as unknown as typeof fetch;
    expect(await postTokenRequest({ domain: "tenant.test" }, {})).toEqual({ status: 403, body: { error: "access_denied" } });
  });
});

describe("parseChallenge", () => {
  it("reads one challenge with its parameters", () => {
    expect(parseChallenge('Bearer error="invalid_token", resource_metadata="http://h/x"')).toEqual({
      scheme: "Bearer",
      params: { error: "invalid_token", resource_metadata: "http://h/x" },
    });
    expect(parseChallenge("Bearer")).toEqual({ scheme: "Bearer", params: {} });
  });

  it("throws on a missing header and on anything that is not a single well formed challenge", () => {
    expect(() => parseChallenge(null)).toThrow(/no WWW-Authenticate/);
    expect(() => parseChallenge('Bearer a="b", DPoP algs="ES256"')).toThrow(/not well formed/);
    expect(() => parseChallenge("")).toThrow(/single challenge/);
  });
});

describe("leak checks", () => {
  it("find a token whole or by its payload or signature segment", () => {
    const parts = REAL_LOOKING.split(".");
    expect(fragmentsOf(REAL_LOOKING)).toEqual([REAL_LOOKING, parts[1], parts[2]]);
    expect(() => expectNoTokens("a place", `nothing here ${parts[1]}`, [REAL_LOOKING])).toThrow(/token #1/);
    expect(() => expectNoTokens("a place", `nothing here ${parts[2]}`, [REAL_LOOKING])).toThrow(/token #1/);
    expect(() => expectNoTokens("a place", "an unrelated body", [REAL_LOOKING])).not.toThrow();
  });
});

describe("hostile token builders", () => {
  it("change only what they claim to change", () => {
    const [header, payload, signature] = REAL_LOOKING.split(".");
    const tampered = withTamperedPayload(REAL_LOOKING).split(".");
    expect(tampered[0]).toBe(header);
    expect(tampered[2]).toBe(signature);
    expect(tampered[1]).not.toBe(payload);
    expect(tampered[1]).toHaveLength(payload!.length);

    const none = withAlgNone(REAL_LOOKING);
    expect(none.endsWith(".")).toBe(true);
    expect(decodeProtectedHeader(none).alg).toBe("none");
    expect(none.split(".")[1]).toBe(payload);

    expect(headerOnly(REAL_LOOKING)).toBe(header);
  });

  it("signs with a key that is not the tenant's, under the real kid, and can claim another issuer", async () => {
    const token = await signedByAttacker(REAL_LOOKING);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "RS256", kid: "k1" });
    expect(decodeJwt(token)).toMatchObject({ iss: "https://tenant.example.com/", aud: "http://127.0.0.1:3000/mcp", sub: "user|1" });
    const other = await signedByAttacker(REAL_LOOKING, { issuer: "https://other.example/" });
    expect(decodeJwt(other).iss).toBe("https://other.example/");
  });
});

describe("loopbackPort", () => {
  it("returns the port of a loopback audience and nothing for any other", () => {
    expect(loopbackPort("http://127.0.0.1:3011/mcp")).toBe(3011);
    expect(loopbackPort("http://localhost:4000/mcp")).toBe(4000);
    expect(loopbackPort("http://127.0.0.1/mcp")).toBeUndefined();
    expect(loopbackPort("https://api.example.test")).toBeUndefined();
    expect(loopbackPort("not a url")).toBeUndefined();
  });
});

describe("installFetchCounter", () => {
  it("counts token endpoint POSTs by grant, lists every request without query or body, and restores", async () => {
    const stub = vi.fn(async () => new Response("ok"));
    globalThis.fetch = stub as unknown as typeof fetch;
    const counter = installFetchCounter();
    const body = new URLSearchParams({ grant_type: TOKEN_EXCHANGE_GRANT }).toString();
    await fetch("https://tenant.test/oauth/token", { method: "POST", body });
    await fetch("https://tenant.test/oauth/token", { method: "POST", body: "grant_type=client_credentials" });
    await fetch("https://tenant.test/.well-known/jwks.json?secret=1");
    expect(counter.exchanges).toBe(1);
    expect(counter.count("client_credentials")).toBe(1);
    expect(counter.requests).toEqual([
      "POST https://tenant.test/oauth/token",
      "POST https://tenant.test/oauth/token",
      "GET https://tenant.test/.well-known/jwks.json",
    ]);
    counter.reset();
    expect(counter.exchanges).toBe(0);
    expect(counter.requests).toEqual([]);
    counter.restore();
    expect(globalThis.fetch).toBe(stub);
  });
});

describe("startFastMcpServer", () => {
  const env = {
    domain: "tenant.invalid",
    issuer: "https://tenant.invalid/",
    oboClientId: "exchange-client",
    oboClientSecret: "exchange-secret-value",
  } as E2eEnv;

  it.each(["client", "inline", "env", "partial"] as const)(
    "starts on the port of the audience in the %s tier, and a request without a token gets the challenge with no tenant traffic",
    async (configuration) => {
      const before = process.env["AUTH0_DOMAIN"];
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const tenantCalls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("tenant.invalid")) tenantCalls.push(url);
        return realFetch(input, init);
      }) as typeof fetch;

      const server = await startFastMcpServer({
        env: { ...env, mcpAudience: `http://127.0.0.1:${port}/mcp` } as E2eEnv,
        downstreamUrl: "http://127.0.0.1:1/data",
        configuration,
      });
      try {
        expect(server.port).toBe(port);
        expect(process.env["AUTH0_DOMAIN"]).toBe(before);
        const refused = await postInitialize(server);
        expect(refused.status).toBe(401);
        expect(refused.challenge?.params["resource_metadata"]).toBe(
          `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`,
        );
        expect(tenantCalls).toEqual([]);
      } finally {
        await server.stop();
      }
    },
  );
});

describe("runner: arguments and settings", () => {
  it("parses flags, repeated --only and bare words, and refuses conflicts and unknown flags", () => {
    expect(lib.parseArgs([])).toEqual({ check: false, slow: false, all: false, verbose: false, help: false, only: [] });
    expect(lib.parseArgs(["--slow", "--verbose", "--only", "obo", "--only=scopes", "metadata"])).toMatchObject({
      slow: true,
      verbose: true,
      only: ["obo", "scopes", "metadata"],
    });
    expect(() => lib.parseArgs(["--slow", "--all"])).toThrow(/either/);
    expect(() => lib.parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => lib.parseArgs(["--only"])).toThrow(/fragment/);
  });

  it("reads KEY=VALUE lines with comments, export, quotes and trailing comments", () => {
    const parsed = lib.parseEnvFile(
      ['# comment', "", "A=1", 'export B="two words"', "C='three'", "D=four # trailing", "not a line"].join("\n"),
    );
    expect(parsed).toEqual({ A: "1", B: "two words", C: "three", D: "four" });
  });

  it("lets a real environment variable win over the file, and fills only empty ones", () => {
    expect(lib.mergeEnv({ A: "env", B: "" }, { A: "file", B: "file", C: "file" })).toEqual({ A: "env", B: "file", C: "file" });
  });

  it("picks the settings file: the named one, else the package's own, else the sibling package's", () => {
    const files = new Set(["/pkg/.env.e2e", "/ai-mcp/.env.e2e", "/named.env"]);
    const exists = (file: string) => files.has(file);
    expect(lib.resolveSettingsFile({ AUTH0_E2E_ENV_FILE: "/named.env" }, "/pkg", exists)).toBe("/named.env");
    expect(lib.resolveSettingsFile({ AUTH0_E2E_ENV_FILE: "/missing.env" }, "/pkg", exists)).toBeUndefined();
    expect(lib.resolveSettingsFile({}, "/pkg", exists)).toBe("/pkg/.env.e2e");
    files.delete("/pkg/.env.e2e");
    expect(lib.resolveSettingsFile({}, "/pkg", exists)).toBe("/ai-mcp/.env.e2e");
    files.delete("/ai-mcp/.env.e2e");
    expect(lib.resolveSettingsFile({}, "/pkg", exists)).toBeUndefined();
  });

  it("names missing required settings and half-set or unset optional groups, never a value", () => {
    const full = Object.fromEntries(lib.REQUIRED_VARS.map((name: string) => [name, "x"]));
    expect(lib.missingRequired(full)).toEqual([]);
    expect(lib.missingRequired({ ...full, AUTH0_E2E_REALM: "" })).toEqual(["AUTH0_E2E_REALM"]);
    expect(lib.halfSetGroups({ ...full, AUTH0_E2E_LIMITED_CLIENT_ID: "id" })).toEqual([
      { group: "limited-client", missing: ["AUTH0_E2E_LIMITED_CLIENT_SECRET"] },
    ]);
    expect(lib.unsetGroups({ ...full, AUTH0_E2E_LIMITED_CLIENT_ID: "id", AUTH0_E2E_LIMITED_CLIENT_SECRET: "s" })).toEqual([
      "second-user",
      "tester-client",
      "expiry",
    ]);
  });

  it("redacts secret values and anything shaped like a JWT, and leaves short values alone", () => {
    const env = { AUTH0_E2E_PASSWORD: "hunter22hunter", AUTH0_E2E_OBO_CLIENT_SECRET: "abc", AUTH0_E2E_DOMAIN: "tenant.example.com" };
    const text = `password hunter22hunter, secret abc, domain tenant.example.com, token ${REAL_LOOKING}`;
    expect(lib.redact(text, env)).toBe(
      "password [redacted], secret abc, domain tenant.example.com, token [redacted jwt]",
    );
  });
});

describe("runner: results and report", () => {
  const json = {
    testResults: [
      {
        name: "/p/test/e2e/dpop.e2e.spec.ts",
        assertionResults: [
          { title: "E-P-01 a", fullName: "x E-P-01 a", status: "passed" },
          { title: "E-P-01 b", fullName: "x E-P-01 b", status: "skipped" },
          { title: "no id here", fullName: "x no id here", status: "passed" },
        ],
      },
      {
        name: "/p/test/e2e/scopes.e2e.spec.ts",
        assertionResults: [
          { title: "E-S-01 a", fullName: "x E-S-01 a", status: "passed" },
          { title: "E-S-01 b", fullName: "x E-S-01 b", status: "failed" },
        ],
      },
      { name: "/p/test/e2e/skipped.e2e.spec.ts", assertionResults: [{ title: "E-Z-99 s", fullName: "E-Z-99 s", status: "skipped" }] },
    ],
  };

  it("makes one row per test, then one row per scenario with the worst status", () => {
    const { rows, skippedFiles } = lib.rowsFromVitestJson(json);
    expect(rows).toHaveLength(6);
    expect(skippedFiles).toEqual(["skipped"]);
    const folded = lib.foldRows(rows);
    expect(folded.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      ["E-P-01", "PASS"],
      ["file:dpop", "PASS"],
      ["E-S-01", "FAIL"],
      ["E-Z-99", "SKIP"],
    ]);
    expect(lib.countRows(folded)).toEqual({ pass: 2, fail: 1, skip: 1 });
    expect(folded[0].detail).toBe("1 passed, 1 skipped, 0 failed of 2 tests");
  });

  it("renders a report with ids, statuses, versions and groups, and no cell can break the table", () => {
    const report = lib.renderReport({
      rows: [{ id: "E-A-01", status: "PASS", file: "a|b", detail: "line\nbreak | pipe" }],
      tests: { pass: 3, fail: 0, skip: 1 },
      skippedGroups: ["expiry"],
      skippedFiles: [],
      tiers: ["fast"],
      exitCode: 0,
      finishedAt: new Date("2026-01-01T00:00:00Z"),
      preflight: ["ok settings: all required settings are present"],
      fastmcpVersion: "4.23.8",
    });
    expect(report).toContain("fastmcp under test: 4.23.8");
    expect(report).toContain("Result: PASS (1 passed, 0 failed, 0 skipped)");
    expect(report).toContain("Tests: 3 passed, 0 failed, 1 skipped");
    expect(report).toContain("| E-A-01 | PASS | a b | line break pipe |");
    expect(report).toContain("did not run: expiry.");
    expect(lib.buildVitestArgs({ config: "c.ts", fragments: ["x"], jsonPath: "/j" })).toEqual([
      "vitest",
      "run",
      "--config",
      "c.ts",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=/j",
      "x",
    ]);
  });
});

describe("runner: preflight", () => {
  const full = Object.fromEntries(lib.REQUIRED_VARS.map((name: string) => [name, "value-long-enough"]));
  const env = { ...full, AUTH0_E2E_DOMAIN: "tenant.example.com", AUTH0_E2E_MCP_AUDIENCE: "https://api.example.test" };

  it("fails on missing settings with names only, and on a half-set optional group", () => {
    const missing = preflight.checkSettings({ ...env, AUTH0_E2E_PASSWORD: "" });
    expect(missing).toEqual({ name: "settings", ok: false, line: "missing required settings: AUTH0_E2E_PASSWORD" });
    const half = preflight.checkSettings({ ...env, AUTH0_E2E_ORG_USER_USERNAME: "u" });
    expect(half.ok).toBe(false);
    expect(half.line).toContain("second-user (missing AUTH0_E2E_ORG_USER_PASSWORD)");
    expect(preflight.checkSettings(env).ok).toBe(true);
  });

  it("fails when the port of a loopback audience is taken, and passes when it is free or not needed", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const port = (holder.address() as { port: number }).port;
    try {
      const taken = await preflight.checkServerPort({ AUTH0_E2E_MCP_AUDIENCE: `http://127.0.0.1:${port}/mcp` });
      expect(taken.ok).toBe(false);
      expect(taken.line).toContain("not free");
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
    expect((await preflight.checkServerPort({ AUTH0_E2E_MCP_AUDIENCE: `http://127.0.0.1:${port}/mcp` })).ok).toBe(true);
    expect((await preflight.checkServerPort(env)).ok).toBe(true);
    expect((await preflight.checkServerPort({ AUTH0_E2E_MCP_AUDIENCE: "nope" })).ok).toBe(false);
  });

  it("runs discovery, login and exchange in order and stops at the first failure, with codes but no values", async () => {
    const discovery = { issuer: "https://tenant.example.com/" };
    const calls: string[] = [];
    const answer = (exchangeStatus: number) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = String(init?.body ?? "");
        calls.push(url.endsWith("openid-configuration") ? "discovery" : body.includes("token-exchange") ? "exchange" : "login");
        if (url.endsWith("openid-configuration")) return new Response(JSON.stringify(discovery));
        if (body.includes("token-exchange")) {
          return new Response(JSON.stringify(exchangeStatus === 200 ? { access_token: "x" } : { error: "access_denied" }), { status: exchangeStatus });
        }
        return new Response(JSON.stringify({ access_token: "user-token-value" }));
      }) as typeof fetch;

    const good = await preflight.runPreflight(env, answer(200));
    expect(good.ok).toBe(true);
    expect(good.steps.map((s: { name: string }) => s.name)).toEqual(["settings", "discovery", "port", "login", "exchange"]);

    const bad = await preflight.runPreflight(env, answer(403));
    expect(bad.ok).toBe(false);
    const last = bad.steps[bad.steps.length - 1];
    expect(last.line).toBe("the on-behalf-of exchange failed: HTTP 403, access_denied");
    expect(JSON.stringify(bad)).not.toContain("user-token-value");
    expect(calls).toContain("exchange");
  });
});
