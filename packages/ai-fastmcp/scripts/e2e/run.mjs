#!/usr/bin/env node
// The one runner of the real-tenant e2e suite. See `--help`.
// Loads the settings file, runs the preflight, runs vitest with the e2e config, prints a short
// summary and writes e2e-report.md (gitignored).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./preflight.mjs";
import {
  USAGE,
  buildVitestArgs,
  countRows,
  foldRows,
  mergeEnv,
  parseArgs,
  parseEnvFile,
  redact,
  renderReport,
  resolveSettingsFile,
  rowsFromVitestJson,
  unsetGroups,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..", "..");
const reportFile = path.join(packageDir, "e2e-report.md");

/** @param {string} command @param {string[]} args @param {import("node:child_process").SpawnOptions} options */
function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    /** @type {Buffer[]} */
    const out = [];
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => out.push(chunk));
    child.on("error", () => resolve({ code: 127, output: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, output: Buffer.concat(out).toString("utf8") }));
  });
}

/** The vitest binary of this package or of the workspace root, else whatever `vitest` is on the PATH. */
function findVitest() {
  const candidates = [
    path.join(packageDir, "node_modules", ".bin", "vitest"),
    path.join(packageDir, "..", "..", "node_modules", ".bin", "vitest"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "vitest";
}

/** The installed fastmcp version, for the report. */
function fastmcpVersion() {
  try {
    const file = path.join(packageDir, "node_modules", "fastmcp", "package.json");
    const fallback = path.join(packageDir, "..", "..", "node_modules", "fastmcp", "package.json");
    const found = [file, fallback].find((candidate) => existsSync(candidate));
    return found === undefined ? "unknown" : String(JSON.parse(readFileSync(found, "utf8")).version);
  } catch {
    return "unknown";
  }
}

/** @param {string[]} fragments @param {string} config @param {Record<string, string | undefined>} env @param {boolean} verbose */
async function runVitest(fragments, config, env, verbose) {
  const dir = mkdtempSync(path.join(tmpdir(), "ai-fastmcp-e2e-"));
  const jsonPath = path.join(dir, "result.json");
  try {
    const args = buildVitestArgs({ config, fragments, jsonPath });
    const childEnv = /** @type {NodeJS.ProcessEnv} */ ({ ...env });
    const result = /** @type {{ code: number, output: string }} */ (
      await run(findVitest(), args.slice(1), { cwd: packageDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] })
    );
    const output = redact(result.output, env);
    if (verbose) process.stdout.write(output);
    else if (result.code !== 0) process.stdout.write(`${output.split("\n").slice(-60).join("\n")}\n`);
    let parsed = { rows: /** @type {import("./lib.mjs").Row[]} */ ([]), skippedFiles: /** @type {string[]} */ ([]) };
    if (existsSync(jsonPath)) parsed = rowsFromVitestJson(JSON.parse(readFileSync(jsonPath, "utf8")));
    return { code: result.code, ...parsed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const settingsFile = resolveSettingsFile(process.env, packageDir, existsSync);
  const fileValues = settingsFile === undefined ? {} : parseEnvFile(readFileSync(settingsFile, "utf8"));
  const env = mergeEnv(process.env, fileValues);
  process.stdout.write(`settings file: ${settingsFile ?? "none (using the environment only)"}\n`);

  const preflight = await runPreflight(env);
  for (const step of preflight.steps) process.stdout.write(`preflight ${step.ok ? "ok  " : "FAIL"} ${step.name}: ${step.line}\n`);
  const preflightLines = preflight.steps.map((s) => `${s.ok ? "ok" : "FAIL"} ${s.name}: ${s.line}`);
  if (!preflight.ok) return 1;
  if (options.check) return 0;

  const tiers = options.slow ? ["slow"] : options.all ? ["fast", "slow"] : ["fast"];
  /** @type {import("./lib.mjs").Row[]} */
  const rows = [];
  /** @type {string[]} */
  const skippedFiles = [];
  let exitCode = 0;
  for (const tier of tiers) {
    const config = tier === "fast" ? "vitest.e2e.config.ts" : "vitest.e2e.slow.config.ts";
    if (!existsSync(path.join(packageDir, config))) {
      process.stderr.write(`The ${tier} tier needs ${path.join(packageDir, config)}, which does not exist yet.\n`);
      exitCode = 2;
      continue;
    }
    const result = await runVitest(options.only, config, env, options.verbose);
    rows.push(...result.rows);
    skippedFiles.push(...result.skippedFiles);
    if (result.code !== 0) exitCode = exitCode || result.code;
  }

  const folded = foldRows(rows);
  const counts = countRows(folded);
  const tests = countRows(rows);
  // A green run that executed nothing is not a pass.
  if (exitCode === 0 && counts.pass === 0) exitCode = 3;
  const skippedGroups = unsetGroups(env);
  writeFileSync(
    reportFile,
    renderReport({
      rows: folded,
      tests,
      skippedGroups,
      skippedFiles,
      tiers,
      exitCode,
      finishedAt: new Date(),
      preflight: preflightLines,
      fastmcpVersion: fastmcpVersion(),
    }),
  );
  process.stdout.write(
    [
      "",
      `e2e ${exitCode === 0 ? "PASS" : "FAIL"}: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped (${tiers.join(" + ")})`,
      `tests: ${tests.pass} passed, ${tests.fail} failed, ${tests.skip} skipped`,
      `fastmcp ${fastmcpVersion()}; skipped groups: ${skippedGroups.length > 0 ? skippedGroups.join(", ") : "none"}`,
      `report: ${reportFile}`,
      "",
    ].join("\n"),
  );
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "e2e runner failed"}\n`);
    process.exitCode = 2;
  },
);
