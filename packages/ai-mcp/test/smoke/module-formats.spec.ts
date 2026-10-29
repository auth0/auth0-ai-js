import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const esmEntry = path.join(packageDir, "dist", "esm", "index.js");
const cjsEntry = path.join(packageDir, "dist", "cjs", "index.js");
const built = existsSync(esmEntry) && existsSync(cjsEntry);

// CI builds before testing, so a missing build there is a failure, not a skip.
if (process.env.CI === "true" && !built) {
  describe("built package formats", () => {
    it("requires dist to be built in CI", () => {
      expect.fail("dist/esm and dist/cjs must exist; run the build before the smoke tests");
    });
  });
}

const expectedValues = [
  "UnauthenticatedError",
  "InsufficientScopeError",
  "DownscopedTokenError",
  "buildPrincipal",
  "mcpClientOptionsFromEnv",
  "resolveMcpClientOptions",
  "createMcpClient",
  "ForeignCallerError",
  "createMcpHandler",
  "authenticateRequest",
  "buildWwwAuthenticate",
  "buildProtectedResourceMetadata",
  "runWithRequestContext",
  "getRequestContext",
  "getCallerPrincipal",
  "getCallerMcpClient",
  "getCallerMcpClientOrThrow",
  "requireScopes",
  "withRequiredScopes",
  "MemoryIndexedTokenStore",
  "createEncryptedTokenStore",
  "AuthError",
  "InvalidConfigurationError",
];

const mcpSdkValues = [
  "createMcpSdkHandler",
  "createNodeMcpHandler",
  "toNodeHandler",
  "asTokenVerifier",
];

// Resolves the package by its own name so the exports map is what gets exercised.
function run(args: string[]): string {
  return execFileSync(process.execPath, args, {
    cwd: packageDir,
    encoding: "utf8",
  }).trim();
}

describe.skipIf(!built)("built package formats", () => {
  it("marks dist/esm as ES modules and dist/cjs as CommonJS", () => {
    const esm = JSON.parse(
      readFileSync(path.join(packageDir, "dist", "esm", "package.json"), "utf8"),
    );
    const cjs = JSON.parse(
      readFileSync(path.join(packageDir, "dist", "cjs", "package.json"), "utf8"),
    );
    expect(esm).toEqual({ type: "module" });
    expect(cjs).toEqual({ type: "commonjs" });
  });

  it("loads through the exports map with a native ESM import()", () => {
    const out = run([
      "--input-type=module",
      "-e",
      "import('@auth0/ai-mcp').then((m) => console.log(JSON.stringify(Object.keys(m).sort())))",
    ]);
    expect(JSON.parse(out)).toEqual([...expectedValues].sort());
  });

  it("loads through the exports map with a native CommonJS require()", () => {
    const out = run([
      "-e",
      "const m = require('@auth0/ai-mcp'); console.log(JSON.stringify(Object.keys(m).sort()))",
    ]);
    expect(JSON.parse(out)).toEqual([...expectedValues].sort());
  });

  it("resolves @auth0/ai-mcp/mcp-sdk through the exports map in ESM", () => {
    const out = run([
      "--input-type=module",
      "-e",
      "import('@auth0/ai-mcp/mcp-sdk').then((m) => console.log(JSON.stringify(Object.keys(m).sort())))",
    ]);
    expect(JSON.parse(out)).toEqual([...mcpSdkValues].sort());
  });

  it("resolves @auth0/ai-mcp/mcp-sdk through the exports map in CommonJS", () => {
    const out = run([
      "-e",
      "const m = require('@auth0/ai-mcp/mcp-sdk'); console.log(JSON.stringify(Object.keys(m).sort()))",
    ]);
    expect(JSON.parse(out)).toEqual([...mcpSdkValues].sort());
  });

  it("does not export the mcp-sdk names from the root entry", () => {
    for (const name of mcpSdkValues) {
      expect(expectedValues).not.toContain(name);
    }
    const out = run([
      "-e",
      "const m = require('@auth0/ai-mcp'); console.log(JSON.stringify(Object.keys(m)))",
    ]);
    const keys: string[] = JSON.parse(out);
    for (const name of mcpSdkValues) {
      expect(keys).not.toContain(name);
    }
  });

  it("exports constructible error classes from both formats", () => {
    const esm = run([
      "--input-type=module",
      "-e",
      "import('@auth0/ai-mcp').then((m) => console.log(new m.UnauthenticatedError() instanceof Error))",
    ]);
    const cjs = run([
      "-e",
      "const m = require('@auth0/ai-mcp'); console.log(new m.UnauthenticatedError() instanceof Error)",
    ]);
    expect(esm).toBe("true");
    expect(cjs).toBe("true");
  });
});

describe.skipIf(!built)("type declarations", () => {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const fixtureConfig = path.join(packageDir, "test", "smoke", "fixtures", "tsconfig.json");

  it("typechecks a CommonJS and an ESM consumer through the exports map", () => {
    const out = execFileSync(process.execPath, [tsc, "--noEmit", "-p", fixtureConfig], {
      cwd: packageDir,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("");
  });
});
