import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const MIN = [2, 3, 0] as const;
const SDK = "@modelcontextprotocol/server";

function resolvedSdkVersion(): { version: string; dir: string } {
  // The package has no ./package.json export, so resolve the entry the example imports and walk up to the package root.
  let dir = dirname(createRequire(import.meta.url).resolve(SDK));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version: string;
      };
      if (pkg.name === SDK) return { version: pkg.version, dir };
    }
    dir = dirname(dir);
  }
  throw new Error(`Could not locate the package root for ${SDK}`);
}

// Semver precedence: build metadata is ignored, and any prerelease sorts below
// its release, so 2.3.0-beta.1 does not satisfy >= 2.3.0.
function meetsMinimum(version: string): boolean {
  const core = version.split("+")[0];
  const dash = core.indexOf("-");
  const hasPrerelease = dash !== -1;
  const nums = (hasPrerelease ? core.slice(0, dash) : core).split(".").map(Number);
  if (nums.length !== 3 || nums.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (nums[i] !== MIN[i]) return nums[i] > MIN[i];
  }
  return !hasPrerelease;
}

describe("MCP SDK version", () => {
  it(`resolves ${SDK} >= ${MIN.join(".")}`, () => {
    const { version, dir } = resolvedSdkVersion();
    const ok = meetsMinimum(version);
    expect(
      ok,
      `${SDK} ${version} resolved from ${dir}, but this example needs >= ${MIN.join(".")}. ` +
        `Install a newer copy next to the example without touching the lockfile, see the README.`,
    ).toBe(true);
  });
});
