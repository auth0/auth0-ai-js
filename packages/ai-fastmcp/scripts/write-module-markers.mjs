// The package.json at the package root has no "type" field, so Node treats every
// .js file below it as CommonJS. Each build output directory therefore gets its own
// marker so that dist/esm loads as ES modules and dist/cjs as CommonJS.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

const markers = [
  ["esm", "module"],
  ["cjs", "commonjs"],
];

for (const [dir, type] of markers) {
  const target = path.join(distDir, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify({ type }, null, 2)}\n`);
}
