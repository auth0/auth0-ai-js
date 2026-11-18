import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(packageDir, "scripts", "stamp-version.mjs");
const PACKAGE_NAME = "@auth0/ai-mcp";
const PLACEHOLDER = "0.0.0-dev";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), "stamp-version-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(version: string, { esm = true, cjs = true, placeholder = true } = {}) {
  const root = scratch();
  const body = (kind: string) => `// ${kind}\nexport const VERSION = "${placeholder ? PLACEHOLDER : "x"}";\n`;
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  for (const [dir, present] of [["esm", esm], ["cjs", cjs]] as const) {
    if (!present) continue;
    mkdirSync(path.join(root, "dist", dir), { recursive: true });
    writeFileSync(path.join(root, "dist", dir, "version.js"), body(dir));
  }
  return root;
}

function stamp(root: string) {
  return spawnSync(
    process.execPath,
    [script, "--package", path.join(root, "package.json"), "--dist", path.join(root, "dist")],
    { encoding: "utf8" },
  );
}

const read = (root: string, dir: string) => readFileSync(path.join(root, "dist", dir, "version.js"), "utf8");

describe("stamp-version script", () => {
  it("replaces the placeholder in dist/esm and dist/cjs", () => {
    const root = fixture("1.2.3");
    const result = stamp(root);
    expect(result.status).toBe(0);
    for (const dir of ["esm", "cjs"]) {
      expect(read(root, dir)).toContain('"1.2.3"');
      expect(read(root, dir)).not.toContain(PLACEHOLDER);
    }
  });

  it("stamps a prerelease version", () => {
    const root = fixture("1.0.0-beta.1");
    expect(stamp(root).status).toBe(0);
    expect(read(root, "cjs")).toContain('"1.0.0-beta.1"');
  });

  it("fails when a built file is missing", () => {
    const root = fixture("1.2.3", { cjs: false });
    const result = stamp(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing");
    expect(read(root, "esm")).toContain(PLACEHOLDER);
  });

  it("fails when the placeholder is not found", () => {
    const root = fixture("1.2.3", { placeholder: false });
    const result = stamp(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("placeholder");
  });

  it("fails when the package version is not semver", () => {
    const root = fixture("latest");
    expect(stamp(root).status).not.toBe(0);
  });

  it("leaves the placeholder for the 0.0.0 development version", () => {
    const root = fixture("0.0.0");
    const result = stamp(root);
    expect(result.status).toBe(0);
    expect(read(root, "esm")).toContain(PLACEHOLDER);
    expect(read(root, "cjs")).toContain(PLACEHOLDER);
  });
});

describe("prepack", () => {
  const version = "7.8.9-beta.3";
  let extracted = "";

  beforeAll(() => {
    // The user npm config may set ignore-scripts, so the flag below makes prepack run.
    // Compile into a temporary package directory, then run a real `npm pack` there so the
    // package.json `prepack` script is what stamps the tarball.
    const root = scratch();
    const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: pkg.name, version, files: pkg.files, scripts: { prepack: pkg.scripts.prepack } }),
    );
    cpSync(path.join(packageDir, "scripts"), path.join(root, "scripts"), { recursive: true });
    const tscBin = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
    // Only the version module is compiled, so this test does not depend on a full build.
    const version_ts = path.join(packageDir, "src", "version.ts");
    const build = (outDir: string, module: string) =>
      execFileSync(
        process.execPath,
        [tscBin, version_ts, "--outDir", path.join(root, outDir), "--target", "es2022", "--module", module, "--moduleResolution", module === "commonjs" ? "node10" : "bundler", "--sourceMap"],
        { cwd: packageDir, stdio: "pipe" },
      );
    build("dist/esm", "esnext");
    build("dist/cjs", "commonjs");
    writeFileSync(path.join(root, "dist", "esm", "package.json"), '{"type":"module"}\n');
    writeFileSync(path.join(root, "dist", "cjs", "package.json"), '{"type":"commonjs"}\n');
    const out = path.join(root, "out");
    mkdirSync(out);
    execFileSync("npm", ["pack", "--pack-destination", out, "--silent", "--ignore-scripts=false"], { cwd: root, stdio: "pipe" });
    extracted = path.join(root, "extracted");
    mkdirSync(extracted);
    const tgz = path.join(out, `${PACKAGE_NAME.replace("@", "").replace("/", "-")}-${version}.tgz`);
    execFileSync("tar", ["-xzf", tgz, "-C", extracted]);
  }, 120_000);

  it("ships the package version, not the placeholder, in the ESM output", () => {
    const file = path.join(extracted, "package", "dist", "esm", "version.js");
    expect(readFileSync(file, "utf8")).not.toContain(PLACEHOLDER);
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(file).href)}).then((m) => console.log(JSON.stringify([m.VERSION, m.PACKAGE_NAME])))`],
      { encoding: "utf8" },
    );
    expect(JSON.parse(out)).toEqual([version, PACKAGE_NAME]);
  });

  it("ships the package version, not the placeholder, in the CJS output", () => {
    const file = path.join(extracted, "package", "dist", "cjs", "version.js");
    expect(readFileSync(file, "utf8")).not.toContain(PLACEHOLDER);
    const out = execFileSync(
      process.execPath,
      ["-e", `const m = require(${JSON.stringify(file)}); console.log(JSON.stringify([m.VERSION, m.PACKAGE_NAME]))`],
      { encoding: "utf8" },
    );
    expect(JSON.parse(out)).toEqual([version, PACKAGE_NAME]);
  });
});

describe("version module", () => {
  it("keeps the placeholder in source so the stamp can find it", () => {
    const source = readFileSync(path.join(packageDir, "src", "version.ts"), "utf8");
    expect(source).toContain(`"${PLACEHOLDER}"`);
  });
});
