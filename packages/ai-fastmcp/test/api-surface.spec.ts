import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const built =
  existsSync(path.join(packageDir, "dist", "esm", "index.js")) &&
  existsSync(path.join(packageDir, "dist", "cjs", "index.js"));

// CI builds before testing, so a missing build there is a failure, not a skip.
if (process.env.CI === "true" && !built) {
  describe("public API surface", () => {
    it("requires dist to be built in CI", () => {
      expect.fail("dist/esm and dist/cjs must exist; run the build before the API surface test");
    });
  });
}

// Any added or removed public runtime export must be reflected here on purpose.
const ROOT_EXPORTS = ["createFastMcpAuth", "withAuth0Execute"];

function names(specifier: string, format: "esm" | "cjs"): string[] {
  const args =
    format === "esm"
      ? [
          "--input-type=module",
          "-e",
          `import('${specifier}').then((m) => console.log(JSON.stringify(Object.keys(m).sort())))`,
        ]
      : ["-e", `console.log(JSON.stringify(Object.keys(require('${specifier}')).sort()))`];
  const out = execFileSync(process.execPath, args, { cwd: packageDir, encoding: "utf8" }).trim();
  return JSON.parse(out) as string[];
}

describe.skipIf(!built)("public API surface", () => {
  for (const format of ["esm", "cjs"] as const) {
    it(`exports exactly the expected runtime names from the root entry (${format})`, () => {
      expect(names("@auth0/ai-fastmcp", format)).toEqual(ROOT_EXPORTS);
    });
  }

  it("marks each output directory with its module format", () => {
    const type = (dir: string) =>
      (JSON.parse(readFileSync(path.join(packageDir, "dist", dir, "package.json"), "utf8")) as { type: string }).type;
    expect(type("esm")).toBe("module");
    expect(type("cjs")).toBe("commonjs");
  });
});
