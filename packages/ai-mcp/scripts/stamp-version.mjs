// Writes the published version of this package into the compiled version modules.
//
// src/version.ts holds a placeholder because the build runs before the release tooling
// sets the package.json version. `prepack` runs this script after that bump and before
// npm builds the tarball, so the tarball carries the real version in both dist/esm and
// dist/cjs. A package.json version of 0.0.0 (a local build) leaves the placeholder.
//
// Usage: node stamp-version.mjs [--package <package.json>] [--dist <dist dir>]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "0.0.0-dev";
const here = path.dirname(fileURLToPath(import.meta.url));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : path.resolve(process.argv[index + 1] ?? "");
}

const packageFile = option("--package", path.resolve(here, "..", "package.json"));
const distDir = option("--dist", path.resolve(here, "..", "dist"));

const { version } = JSON.parse(readFileSync(packageFile, "utf8"));
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`stamp-version: ${packageFile} has no valid semver version (${JSON.stringify(version)}).`);
  process.exit(1);
}

const targets = ["esm", "cjs"].map((dir) => path.join(distDir, dir, "version.js"));
const contents = targets.map((file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    console.error(`stamp-version: ${file} is missing. Run the build before packing.`);
    process.exit(1);
  }
});

if (version === "0.0.0") {
  console.log(`stamp-version: package version is 0.0.0, leaving the ${PLACEHOLDER} placeholder in place.`);
  process.exit(0);
}

targets.forEach((file, index) => {
  if (!contents[index].includes(PLACEHOLDER)) {
    console.error(`stamp-version: ${file} does not contain the ${PLACEHOLDER} placeholder.`);
    process.exit(1);
  }
});

targets.forEach((file, index) => {
  writeFileSync(file, contents[index].split(PLACEHOLDER).join(version));
});
console.log(`stamp-version: stamped ${version} into ${targets.length} files.`);
