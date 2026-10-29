import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
}

describe("example structure", () => {
  it("keeps all Auth0 wiring in auth.ts and only tools in tools.ts", () => {
    const auth = source("auth.ts");
    expect(auth).toContain("createFastMcpAuth(");
    expect(auth).toContain("tokenStore");

    const tools = source("tools.ts");
    expect(tools).not.toContain("createFastMcpAuth");
    expect(tools).not.toContain("createMcpClient");
    expect(tools).not.toContain("MemoryIndexedTokenStore");
    expect(tools).toContain("withAuth0Execute(");
  });

  it("spreads the options of createAuth into FastMCP and registers the tools", () => {
    const app = source("app.ts");
    expect(app).toContain("...createAuth(config)");
    expect(app).toContain("registerTools(server, config)");
  });

  it("exchanges tokens through both access paths of the package", () => {
    const tools = source("tools.ts");
    expect(tools).toContain("getCallerMcpClientOrThrow().getTokenOnBehalfOf(");
    expect(tools).toContain("session.mcpClient.getTokenOnBehalfOf(");
  });

  it("reads the session of a wrapped tool without a non-null assertion", () => {
    expect(source("tools.ts")).not.toMatch(/\bsession!/);
  });

  it("serves in the stateless HTTP mode", () => {
    expect(source("server.ts")).toContain("stateless: true");
  });

  it("does not use FastMCP's own auth option", () => {
    expect(source("app.ts")).not.toMatch(/\bauth:/);
  });
});
