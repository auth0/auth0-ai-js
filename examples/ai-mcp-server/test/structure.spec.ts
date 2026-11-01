import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
}

describe("example structure", () => {
  it("keeps all SDK wiring in auth.ts and only tools in mcp-app.ts", () => {
    const auth = source("auth.ts");
    expect(auth).toContain("createNodeMcpHandler(");
    expect(auth).toContain("tokenStore");

    const app = source("mcp-app.ts");
    expect(app).not.toContain("createNodeMcpHandler");
    expect(app).not.toContain("createMcpClient");
    expect(app).not.toContain("MemoryIndexedTokenStore");
    expect(app).toContain("createAuthenticatedHandler");
  });

  it("does not use the old connection method name", () => {
    for (const name of ["mcp-app.ts", "auth.ts"]) {
      expect(source(name)).not.toContain("getTokenForService");
    }
  });

  it("tells the reader to build the package first, by its real name, and keeps no scratch install", () => {
    const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
    const readme = readFileSync(here("../README.md"), "utf8");
    const { name } = JSON.parse(readFileSync(here("../../../packages/ai-mcp/package.json"), "utf8")) as {
      name: string;
    };

    expect(readme).toContain(`npm run build --workspace ${name}`);
    expect(readme).not.toContain("npm install --no-save");
  });
});
