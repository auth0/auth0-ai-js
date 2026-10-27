// Pure helpers of the e2e runner: argument parsing, env file loading, environment checks,
// secret redaction and report rendering. No network and no process side effects, so the offline
// unit suite can import and test them. run.mjs and preflight.mjs are thin shells over these.
import path from "node:path";

/** Variables every scenario needs. Keep in step with `test/e2e/support/env.ts`. */
export const REQUIRED_VARS = [
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

/**
 * @typedef {object} EnvGroup
 * @property {string} name Short label used in messages and in the skipped list.
 * @property {string[]} vars Every variable of the group.
 * @property {(env: Record<string, string | undefined>) => boolean} complete True when the group is usable.
 */

const present = (/** @type {Record<string, string | undefined>} */ env, /** @type {string} */ name) =>
  (env[name] ?? "") !== "";
const allPresent = (/** @type {string[]} */ vars) => (/** @type {Record<string, string | undefined>} */ env) =>
  vars.every((v) => present(env, v));

/** @type {EnvGroup[]} */
export const OPTIONAL_GROUPS = [
  { name: "m2m", vars: ["AUTH0_E2E_M2M_CLIENT_ID", "AUTH0_E2E_M2M_CLIENT_SECRET"], complete: allPresent(["AUTH0_E2E_M2M_CLIENT_ID", "AUTH0_E2E_M2M_CLIENT_SECRET"]) },
  {
    name: "management",
    vars: ["AUTH0_E2E_MGMT_TOKEN", "AUTH0_E2E_MGMT_CLIENT_ID", "AUTH0_E2E_MGMT_CLIENT_SECRET"],
    complete: (env) =>
      present(env, "AUTH0_E2E_MGMT_TOKEN") || (present(env, "AUTH0_E2E_MGMT_CLIENT_ID") && present(env, "AUTH0_E2E_MGMT_CLIENT_SECRET")),
  },
  {
    name: "multi-service",
    vars: ["AUTH0_E2E_ORDERS_AUDIENCE", "AUTH0_E2E_INVENTORY_AUDIENCE", "AUTH0_E2E_ANALYTICS_AUDIENCE", "AUTH0_E2E_LEDGER_AUDIENCE"],
    complete: allPresent(["AUTH0_E2E_ORDERS_AUDIENCE", "AUTH0_E2E_INVENTORY_AUDIENCE", "AUTH0_E2E_ANALYTICS_AUDIENCE", "AUTH0_E2E_LEDGER_AUDIENCE"]),
  },
  {
    name: "limited-client",
    vars: ["AUTH0_E2E_LIMITED_CLIENT_ID", "AUTH0_E2E_LIMITED_CLIENT_SECRET"],
    complete: allPresent(["AUTH0_E2E_LIMITED_CLIENT_ID", "AUTH0_E2E_LIMITED_CLIENT_SECRET"]),
  },
  {
    name: "organizations",
    vars: [
      "AUTH0_E2E_ORG_A_ID",
      "AUTH0_E2E_ORG_B_ID",
      "AUTH0_E2E_ORG_USER_USERNAME",
      "AUTH0_E2E_ORG_USER_PASSWORD",
      "AUTH0_E2E_AUTHCODE_CLIENT_ID",
      "AUTH0_E2E_AUTHCODE_CLIENT_SECRET",
      "AUTH0_E2E_AUTHCODE_REDIRECT_PORT",
      "AUTH0_E2E_ORG_TESTER_CLIENT_ID",
      "AUTH0_E2E_ORG_TESTER_CLIENT_SECRET",
    ],
    complete: allPresent([
      "AUTH0_E2E_ORG_A_ID",
      "AUTH0_E2E_ORG_B_ID",
      "AUTH0_E2E_ORG_USER_USERNAME",
      "AUTH0_E2E_ORG_USER_PASSWORD",
      "AUTH0_E2E_AUTHCODE_CLIENT_ID",
      "AUTH0_E2E_AUTHCODE_CLIENT_SECRET",
      "AUTH0_E2E_AUTHCODE_REDIRECT_PORT",
      "AUTH0_E2E_ORG_TESTER_CLIENT_ID",
      "AUTH0_E2E_ORG_TESTER_CLIENT_SECRET",
    ]),
  },
  {
    name: "expiry",
    vars: [
      "AUTH0_E2E_SHORT_MCP_AUDIENCE",
      "AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE",
      "AUTH0_E2E_SHORT_LIFETIME_SECONDS",
      "AUTH0_E2E_SHORT_OBO_CLIENT_ID",
      "AUTH0_E2E_SHORT_OBO_CLIENT_SECRET",
    ],
    complete: allPresent([
      "AUTH0_E2E_SHORT_MCP_AUDIENCE",
      "AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE",
      "AUTH0_E2E_SHORT_LIFETIME_SECONDS",
      "AUTH0_E2E_SHORT_OBO_CLIENT_ID",
      "AUTH0_E2E_SHORT_OBO_CLIENT_SECRET",
    ]),
  },
  {
    name: "real-client",
    vars: ["AUTH0_E2E_CLAUDE_BIN", "AUTH0_E2E_T2_PORT", "AUTH0_E2E_T2_MCP_AUDIENCE", "AUTH0_E2E_T2_USERNAME", "AUTH0_E2E_T2_PASSWORD"],
    complete: allPresent(["AUTH0_E2E_T2_PORT", "AUTH0_E2E_T2_MCP_AUDIENCE", "AUTH0_E2E_T2_USERNAME", "AUTH0_E2E_T2_PASSWORD"]),
  },
];

/** Standalone optional variables that belong to no group. */
export const LOOSE_VARS = ["AUTH0_E2E_DOWNSTREAM_SCOPE", "AUTH0_E2E_ORG_ID", "AUTH0_E2E_EXPIRED_TOKEN"];

/** Every variable name the suite knows. `.env.e2e.example` lists exactly these. */
export const ALL_VARS = [...new Set([...REQUIRED_VARS, ...OPTIONAL_GROUPS.flatMap((g) => g.vars), ...LOOSE_VARS])];

/**
 * @typedef {object} Options
 * @property {boolean} check Stop after the preflight.
 * @property {boolean} slow Run the slow tier only.
 * @property {boolean} all Run the fast and the slow tier.
 * @property {boolean} setup Run the tenant setup script first.
 * @property {boolean} verbose Stream the test output instead of summarizing it.
 * @property {boolean} help
 * @property {string[]} only File name fragments to run.
 */

/**
 * Parses the runner arguments. File name fragments come from `--only <fragment>` (repeatable) or
 * as bare words, so `npm run e2e -- m2m obo` works too.
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { check: false, slow: false, all: false, setup: false, verbose: false, help: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--check") options.check = true;
    else if (arg === "--slow") options.slow = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--setup") options.setup = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--only needs a file name fragment.");
      options.only.push(value);
      i += 1;
    } else if (arg.startsWith("--only=")) {
      const value = arg.slice("--only=".length);
      if (value === "") throw new Error("--only needs a file name fragment.");
      options.only.push(value);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}. Use --help to see the options.`);
    } else {
      options.only.push(arg);
    }
  }
  if (options.slow && options.all) throw new Error("Use either --slow or --all, not both.");
  return options;
}

export const USAGE = `Usage: npm run e2e -- [options] [fragment ...]

  --check          run the preflight only (env names, discovery, one login, one exchange)
  --slow           run the slow tier only (real waiting for token expiry)
  --all            run the fast tier, then the slow tier
  --only <name>    run spec files whose name contains <name> (repeatable; bare words work too)
  --setup          run scripts/e2e/tenant/setup.sh first (a person with Auth0 CLI access runs this)
  --verbose        stream the test output
  -h, --help       show this text

Settings come from packages/ai-mcp/.env.e2e (see .env.e2e.example). Real environment variables win.
`;

/**
 * Parses KEY=VALUE lines. Supports comments, blank lines, an optional `export ` prefix and single
 * or double quoted values. Does not expand variables.
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvFile(content) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = /** @type {string} */ (match[1]);
    let value = /** @type {string} */ (match[2]).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[name] = value;
  }
  return out;
}

/**
 * Merges file values under real environment variables: a variable that is set to a non-empty
 * value in `base` is never replaced by the file.
 * @param {Record<string, string | undefined>} base
 * @param {Record<string, string>} fromFile
 * @returns {Record<string, string | undefined>}
 */
export function mergeEnv(base, fromFile) {
  const merged = { ...base };
  for (const [name, value] of Object.entries(fromFile)) {
    if ((merged[name] ?? "") === "") merged[name] = value;
  }
  return merged;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} Names of required variables that are empty or unset.
 */
export function missingRequired(env) {
  return REQUIRED_VARS.filter((name) => (env[name] ?? "") === "");
}

/**
 * Groups that are partly set. A half-set group makes the matching specs fail, so the preflight
 * reports it before any test runs.
 * @param {Record<string, string | undefined>} env
 * @returns {{ group: string, missing: string[] }[]}
 */
export function halfSetGroups(env) {
  /** @type {{ group: string, missing: string[] }[]} */
  const out = [];
  for (const group of OPTIONAL_GROUPS) {
    const set = group.vars.filter((v) => (env[v] ?? "") !== "");
    if (set.length === 0 || group.complete(env)) continue;
    const missing = group.vars.filter((v) => (env[v] ?? "") === "");
    // For the management group an unset token alone is not "missing" when the pair is complete,
    // and the pair being incomplete is what needs reporting.
    out.push({ group: group.name, missing: group.name === "management" ? missing.filter((v) => v !== "AUTH0_E2E_MGMT_TOKEN") : missing });
  }
  return out;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} Names of optional groups with no variable set at all.
 */
export function unsetGroups(env) {
  return OPTIONAL_GROUPS.filter((g) => g.vars.every((v) => (env[v] ?? "") === "")).map((g) => g.name);
}

const SECRET_NAME = /SECRET|PASSWORD|TOKEN/;

/**
 * Replaces the value of every secret-like variable in `text`. Values shorter than 6 characters
 * are ignored so that short, common strings do not shred the output.
 * @param {string} text
 * @param {Record<string, string | undefined>} env
 */
export function redact(text, env) {
  let out = text;
  const values = ALL_VARS.filter((name) => SECRET_NAME.test(name))
    .map((name) => env[name] ?? "")
    .filter((value) => value.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("[redacted]");
  return out;
}

/**
 * Builds the vitest argument list.
 * @param {{ config: string, fragments: string[], jsonPath: string }} input
 */
export function buildVitestArgs({ config, fragments, jsonPath }) {
  return ["vitest", "run", "--config", config, "--reporter=default", "--reporter=json", `--outputFile.json=${jsonPath}`, ...fragments];
}

const SCENARIO_ID = /\b(?:E-[A-Z]-\d{2,3}|T2-\d{2})\b/;

/**
 * @typedef {object} Row
 * @property {string} id Scenario id, or `file:<name>` for tests with no id in their title.
 * @property {"PASS" | "FAIL" | "SKIP"} status
 * @property {string} file
 * @property {string} detail
 */

/**
 * Turns vitest's JSON report into one row per scenario id. Tests without an id in their title are
 * folded into one row per spec file.
 * @param {{ testResults?: { name: string, assertionResults?: { title?: string, fullName?: string, status: string }[] }[] }} json
 * @returns {{ rows: Row[], skippedFiles: string[] }}
 */
export function rowsFromVitestJson(json) {
  /** @type {Row[]} */
  const rows = [];
  /** @type {string[]} */
  const skippedFiles = [];
  for (const file of json.testResults ?? []) {
    const fileName = path.basename(file.name).replace(/\.e2e(\.slow)?\.spec\.ts$/, "");
    const tests = file.assertionResults ?? [];
    /** @type {Record<string, number>} */
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const test of tests) {
      const bucket = test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped";
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      const id = SCENARIO_ID.exec(test.fullName ?? test.title ?? "")?.[0];
      if (id !== undefined) {
        rows.push({
          id,
          status: bucket === "passed" ? "PASS" : bucket === "failed" ? "FAIL" : "SKIP",
          file: fileName,
          detail: test.title ?? "",
        });
      }
    }
    if (tests.length > 0 && counts["passed"] === 0 && counts["failed"] === 0) skippedFiles.push(fileName);
    const unnamed = tests.filter((t) => !SCENARIO_ID.test(t.fullName ?? t.title ?? ""));
    if (unnamed.length > 0 || tests.length === 0) {
      const failed = unnamed.filter((t) => t.status === "failed").length;
      const passed = unnamed.filter((t) => t.status === "passed").length;
      rows.push({
        id: `file:${fileName}`,
        status: failed > 0 ? "FAIL" : passed > 0 ? "PASS" : "SKIP",
        file: fileName,
        detail: `${passed} passed, ${failed} failed, ${unnamed.length - passed - failed} skipped`,
      });
    }
  }
  return { rows, skippedFiles };
}

/**
 * @param {Row[]} rows
 * @returns {{ pass: number, fail: number, skip: number }}
 */
export function countRows(rows) {
  return {
    pass: rows.filter((r) => r.status === "PASS").length,
    fail: rows.filter((r) => r.status === "FAIL").length,
    skip: rows.filter((r) => r.status === "SKIP").length,
  };
}

/** Escapes a table cell. Test titles are untrusted text, so strip pipes and line breaks. */
function cell(/** @type {string} */ value) {
  return value.replace(/\s*[|\r\n]+\s*/g, " ").trim();
}

/**
 * Renders the markdown report. It holds scenario ids, statuses, file names and counts only, no
 * environment values and no tokens.
 * @param {{ rows: Row[], skippedGroups: string[], skippedFiles: string[], tiers: string[], exitCode: number, finishedAt: Date, preflight: string[] }} input
 */
export function renderReport({ rows, skippedGroups, skippedFiles, tiers, exitCode, finishedAt, preflight }) {
  const counts = countRows(rows);
  const lines = [
    "# ai-mcp real-tenant e2e report",
    "",
    `Finished: ${finishedAt.toISOString()}`,
    `Tiers: ${tiers.join(", ")}`,
    `Result: ${exitCode === 0 ? "PASS" : "FAIL"} (${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped)`,
    "",
    "## Preflight",
    "",
    ...(preflight.length > 0 ? preflight.map((line) => `- ${cell(line)}`) : ["- not run"]),
    "",
    "## Scenarios",
    "",
    "| Id | Status | Spec | Detail |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${cell(r.id)} | ${r.status} | ${cell(r.file)} | ${cell(r.detail)} |`),
    "",
    "## Skipped groups",
    "",
    ...(skippedGroups.length > 0
      ? [`Settings not provided, so the scenarios that need them did not run: ${skippedGroups.join(", ")}.`]
      : ["None. Every optional settings group is present."]),
    ...(skippedFiles.length > 0 ? ["", `Spec files where every test was skipped: ${skippedFiles.join(", ")}.`] : []),
    "",
  ];
  return lines.join("\n");
}
