/** The FastMCP release the suites run against, read from the installed package. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { packageDir } from "./guides.js";

/** The oldest FastMCP release the package supports. */
export const FLOOR = [4, 22, 0] as const;

export function installedFastmcpVersion(): string {
  const candidates = [
    path.join(packageDir, "node_modules", "fastmcp", "package.json"),
    path.join(packageDir, "..", "..", "node_modules", "fastmcp", "package.json"),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (file === undefined) throw new Error("fastmcp is not installed.");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

export function parseVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split("-")[0]!.split(".").map(Number);
  return [major, minor, patch];
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The first FastMCP release whose tool result schema allows `_meta`. */
export const META_FLOOR = [4, 7, 0] as const;

/** Whether the installed FastMCP rejects `_meta` in a tool result. Only a deliberate run on an old release does. */
export function isBelowMetaFloor(): boolean {
  return compareVersions(parseVersion(installedFastmcpVersion()), META_FLOOR) < 0;
}
