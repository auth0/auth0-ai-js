/** Offline checks of the e2e runner helpers in scripts/e2e. No tenant, no network, no child process. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classifyError, classifyExchange, classifySignIn } from "../../scripts/e2e/classify.mjs";
import {
  ALL_VARS,
  REQUIRED_VARS,
  buildVitestArgs,
  halfSetGroups,
  mergeEnv,
  missingRequired,
  parseArgs,
  parseEnvFile,
  redact,
  renderReport,
  rowsFromVitestJson,
  unsetGroups,
} from "../../scripts/e2e/lib.mjs";
import { checkSettings, runPreflight } from "../../scripts/e2e/preflight.mjs";

const fullEnv = (): Record<string, string> =>
  Object.fromEntries(REQUIRED_VARS.map((name) => [name, name === "AUTH0_E2E_DOMAIN" ? "tenant.example.test" : `value-of-${name.toLowerCase()}`]));

describe("parseArgs", () => {
  it("has everything off by default", () => {
    expect(parseArgs([])).toEqual({ check: false, slow: false, all: false, setup: false, verbose: false, help: false, only: [] });
  });

  it("reads flags, repeated --only values, --only=value and bare fragments", () => {
    const options = parseArgs(["--check", "--setup", "--only", "m2m", "--only=faults", "obo-cache"]);
    expect(options.check).toBe(true);
    expect(options.setup).toBe(true);
    expect(options.only).toEqual(["m2m", "faults", "obo-cache"]);
  });

  it("rejects unknown options, a dangling --only and --slow with --all", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option --bogus/);
    expect(() => parseArgs(["--only"])).toThrow(/--only needs/);
    expect(() => parseArgs(["--only", "--slow"])).toThrow(/--only needs/);
    expect(() => parseArgs(["--slow", "--all"])).toThrow(/either --slow or --all/);
  });
});

describe("env file loading", () => {
  it("parses comments, export, quotes and inline comments", () => {
    const parsed = parseEnvFile(
      ["# comment", "", "A=1", "export B=two words", 'C="quoted # not a comment"', "D='single'", "E=value # trailing", "F=", "not a line"].join("\n"),
    );
    expect(parsed).toEqual({ A: "1", B: "two words", C: "quoted # not a comment", D: "single", E: "value", F: "" });
  });

  it("lets real environment variables win over the file, and fills only unset or empty ones", () => {
    const merged = mergeEnv({ A: "env", B: "", C: undefined }, { A: "file", B: "file", C: "file", D: "file" });
    expect(merged).toEqual({ A: "env", B: "file", C: "file", D: "file" });
  });

  it("keeps the example file in step with the variables the runner knows", () => {
    const example = readFileSync(new URL("../../.env.e2e.example", import.meta.url), "utf8");
    const names = Object.keys(parseEnvFile(example)).sort();
    expect(names).toEqual([...ALL_VARS].sort());
    for (const value of Object.values(parseEnvFile(example))) expect(value).toBe("");
  });
});

describe("environment checks", () => {
  it("lists missing required names only", () => {
    const env = { ...fullEnv(), AUTH0_E2E_PASSWORD: "" };
    delete (env as Record<string, string | undefined>)["AUTH0_E2E_REALM"];
    expect(missingRequired(env)).toEqual(["AUTH0_E2E_PASSWORD", "AUTH0_E2E_REALM"]);
    const step = checkSettings(env);
    expect(step.ok).toBe(false);
    expect(step.line).toContain("AUTH0_E2E_PASSWORD, AUTH0_E2E_REALM");
    expect(step.line).not.toContain("value-of");
  });

  it("flags half-set optional groups and treats an unset group as skipped, not broken", () => {
    const env = { ...fullEnv(), AUTH0_E2E_M2M_CLIENT_ID: "id", AUTH0_E2E_MGMT_CLIENT_ID: "id" };
    expect(halfSetGroups(env)).toEqual([
      { group: "m2m", missing: ["AUTH0_E2E_M2M_CLIENT_SECRET"] },
      { group: "management", missing: ["AUTH0_E2E_MGMT_CLIENT_SECRET"] },
    ]);
    expect(unsetGroups(env)).not.toContain("m2m");
    expect(unsetGroups(fullEnv())).toContain("m2m");
    expect(halfSetGroups({ ...fullEnv(), AUTH0_E2E_MGMT_TOKEN: "t" })).toEqual([]);
    const step = checkSettings(env);
    expect(step.ok).toBe(false);
    expect(step.line).toContain("AUTH0_E2E_M2M_CLIENT_SECRET");
  });

  it("redacts secret-like values and leaves other text alone", () => {
    const env = { AUTH0_E2E_OBO_CLIENT_SECRET: "super-secret-value", AUTH0_E2E_DOMAIN: "tenant.example.test", AUTH0_E2E_PASSWORD: "abc" };
    expect(redact("x super-secret-value y tenant.example.test abc", env)).toBe("x [redacted] y tenant.example.test abc");
  });
});

describe("classifyExchange", () => {
  const cases: Array<[string, { status: number; body: unknown }, string]> = [
    ["enabled", { status: 200, body: { access_token: "t" } }, "enabled"],
    ["tenant feature off", { status: 400, body: { error: "invalid_request", error_description: "Client must be a Custom API Client with resource_server_id" } }, "not_enabled"],
    ["unsupported grant", { status: 400, body: { error: "unsupported_grant_type" } }, "not_allowed"],
    ["bad secret", { status: 401, body: { error: "invalid_client" } }, "bad_secret"],
    ["unknown audience", { status: 400, body: { error: "invalid_target" } }, "unknown_audience"],
    ["missing grant", { status: 403, body: { error: "access_denied" } }, "missing_grant"],
    ["something else", { status: 500, body: { error: "server_error" } }, "other"],
    ["garbage", { status: 0, body: "nope" }, "other"],
  ];
  it.each(cases)("%s", (_name, response, code) => {
    const result = classifyExchange(response);
    expect(result.code).toBe(code);
    expect(result.ok).toBe(code === "enabled");
  });

  it("never echoes the body of an error", () => {
    const result = classifyExchange({ status: 500, body: { error: "server_error", error_description: "leaked-detail" } });
    expect(result.line).not.toContain("leaked-detail");
  });
});

describe("classifySignIn and classifyError", () => {
  it("separates a stale password from other sign-in failures", () => {
    expect(classifySignIn({ status: 403, body: { error: "invalid_grant" } }).code).toBe("signin_stale_password");
    expect(classifySignIn({ status: 429, body: { error: "too_many_attempts" } }).code).toBe("signin_failed");
  });

  it("reports network errors as such and other errors without their message", () => {
    expect(classifyError(new TypeError("fetch failed")).code).toBe("network");
    expect(classifyError(Object.assign(new Error("x"), { name: "TimeoutError" })).code).toBe("network");
    const other = classifyError(new RangeError("contains-a-secret"));
    expect(other.code).toBe("other");
    expect(other.line).not.toContain("contains-a-secret");
  });
});

describe("runPreflight", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("stops before any request when settings are missing", async () => {
    const fetchImpl = vi.fn();
    const result = await runPreflight({}, fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes with a reachable tenant, a working login and an enabled exchange", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/.well-known/openid-configuration")) return json(200, { issuer: "https://tenant.example.test/" });
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type")?.includes("password-realm")) return json(200, { access_token: "user-token" });
      expect(form.get("subject_token")).toBe("user-token");
      return json(200, { access_token: "downstream-token" });
    });
    const result = await runPreflight(fullEnv(), fetchImpl as unknown as typeof fetch);
    expect(result.steps.map((s) => s.name)).toEqual(["settings", "discovery", "login", "exchange"]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.steps)).not.toContain("user-token");
  });

  it("stops at a failed login and does not attempt the exchange", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("openid-configuration") ? json(200, { issuer: "https://tenant.example.test/" }) : json(403, { error: "invalid_grant" }),
    );
    const result = await runPreflight(fullEnv(), fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.name).toBe("login");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports an unreachable tenant as a network problem", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runPreflight(fullEnv(), fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.line).toMatch(/could not reach Auth0/);
  });

  it("rejects a domain that is not a bare host name", async () => {
    const fetchImpl = vi.fn();
    const result = await runPreflight({ ...fullEnv(), AUTH0_E2E_DOMAIN: "https://tenant.example.test/x" }, fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("report", () => {
  const vitestJson = {
    testResults: [
      {
        name: "/p/test/e2e/faults.e2e.spec.ts",
        assertionResults: [
          { title: "E-F-05: slow", fullName: "e2e fault injection E-F-05: slow", status: "passed" },
          { title: "exchange 503", fullName: "e2e fault injection exchange 503", status: "passed" },
          { title: "exchange 500", fullName: "e2e fault injection exchange 500", status: "failed" },
        ],
      },
      { name: "/p/test/e2e/org.e2e.spec.ts", assertionResults: [{ title: "needs org", fullName: "org needs org", status: "skipped" }] },
    ],
  };

  it("builds a row per scenario id and one aggregate row per spec file for the rest", () => {
    const { rows, skippedFiles } = rowsFromVitestJson(vitestJson);
    expect(rows).toEqual([
      { id: "E-F-05", status: "PASS", file: "faults", detail: "E-F-05: slow" },
      { id: "file:faults", status: "FAIL", file: "faults", detail: "1 passed, 1 failed, 0 skipped" },
      { id: "file:org", status: "SKIP", file: "org", detail: "0 passed, 0 failed, 1 skipped" },
    ]);
    expect(skippedFiles).toEqual(["org"]);
  });

  it("renders ids, skipped groups and the result, and builds the vitest command", () => {
    const { rows, skippedFiles } = rowsFromVitestJson(vitestJson);
    const text = renderReport({
      rows,
      skippedGroups: ["m2m", "expiry"],
      skippedFiles,
      tiers: ["fast"],
      exitCode: 1,
      finishedAt: new Date("2026-10-26T00:00:00Z"),
      preflight: ["ok settings: all required settings are present"],
    });
    expect(text).toContain("| E-F-05 | PASS | faults |");
    expect(text).toContain("Result: FAIL (1 passed, 1 failed, 1 skipped)");
    expect(text).toContain("m2m, expiry");
    expect(text).toContain("Spec files where every test was skipped: org.");
    expect(buildVitestArgs({ config: "c.ts", fragments: ["m2m"], jsonPath: "/tmp/r.json" })).toEqual([
      "vitest", "run", "--config", "c.ts", "--reporter=default", "--reporter=json", "--outputFile.json=/tmp/r.json", "m2m",
    ]);
  });

  it("keeps table cells on one line", () => {
    const text = renderReport({
      rows: [{ id: "E-X-01", status: "PASS", file: "a", detail: "has | pipe\nand newline" }],
      skippedGroups: [],
      skippedFiles: [],
      tiers: ["fast"],
      exitCode: 0,
      finishedAt: new Date(0),
      preflight: [],
    });
    expect(text).toContain("| E-X-01 | PASS | a | has pipe and newline |");
  });
});
