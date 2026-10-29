import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const MIN = [4, 7, 0] as const;
const PACKAGE = "fastmcp";

function resolvedVersion(): { version: string; dir: string } {
  // Resolve the entry the example imports and walk up to the package root.
  let dir = dirname(createRequire(import.meta.url).resolve(PACKAGE));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version: string };
      if (pkg.name === PACKAGE) return { version: pkg.version, dir };
    }
    dir = dirname(dir);
  }
  throw new Error(`Could not locate the package root for ${PACKAGE}`);
}

// Semver precedence: build metadata is ignored, and a prerelease sorts below its release.
function meetsMinimum(version: string): boolean {
  const core = version.split("+")[0] ?? version;
  const dash = core.indexOf("-");
  const hasPrerelease = dash !== -1;
  const nums = (hasPrerelease ? core.slice(0, dash) : core).split(".").map(Number);
  if (nums.length !== 3 || nums.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (nums[i] !== MIN[i]) return (nums[i] ?? 0) > MIN[i]!;
  }
  return !hasPrerelease;
}

describe("FastMCP version", () => {
  it(`resolves ${PACKAGE} >= ${MIN.join(".")}`, () => {
    const { version, dir } = resolvedVersion();
    expect(
      meetsMinimum(version),
      `${PACKAGE} ${version} resolved from ${dir}, but this example needs >= ${MIN.join(".")}, the oldest release the adapter supports.`,
    ).toBe(true);
  });
});
