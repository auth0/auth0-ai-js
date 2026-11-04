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
    expect(app).toContain("...(options.auth ?? createAuth(config))");
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

  it("takes the route from auth.endpoint and the port from the audience", () => {
    expect(source("server.ts")).toContain("endpoint: auth.endpoint");
    expect(source("config.ts")).toContain('env["AUTH0_AUDIENCE"]');
    expect(readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8")).not.toMatch(/^MCP_PORT=/m);
  });

  it("publishes the scope of cancel_order, which only that tool checks", () => {
    const auth = source("auth.ts");
    expect(auth).toContain("scopesSupported");
    expect(auth).toContain("SCOPE_CANCEL_ORDER");
  });

  it("does not use FastMCP's own auth option", () => {
    expect(source("app.ts")).not.toMatch(/\bauth:/);
  });

  it("tells the reader to build both workspace packages first, by their real names and in dependency order", () => {
    const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
    const readme = readFileSync(here("../README.md"), "utf8");
    const nameOf = (dir: string) =>
      (JSON.parse(readFileSync(here(`../../../packages/${dir}/package.json`), "utf8")) as { name: string }).name;

    // dist folders are not committed, and ai-fastmcp compiles against the build of ai-mcp, so the order matters.
    expect(readme).toContain(`npm run build --workspace ${nameOf("ai-mcp")} --workspace ${nameOf("ai-fastmcp")}`);
    expect(readme.indexOf("npm run build --workspace")).toBeLessThan(readme.indexOf("npm run start:api"));
    expect(readme).not.toContain("npm install --no-save");
  });
});
