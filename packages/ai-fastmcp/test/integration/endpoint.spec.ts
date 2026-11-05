import { createMcpClient } from "@auth0/ai-mcp";
import { FastMCP } from "fastmcp";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import type { Auth0Session } from "../../src/index.js";
import { DOMAIN, freePort, rawRequest } from "./harness.js";

function delegateTool(server: FastMCP<Auth0Session>): void {
  server.addTool({
    name: "delegate",
    description: "Replies.",
    parameters: z.object({}),
    execute: withAuth0Execute(async () => "ok"),
  });
}

describe("auth.endpoint with an audience that has its own path", () => {
  it("serves the route and the metadata at the audience path when auth.endpoint goes to start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const client = createMcpClient({
      domain: DOMAIN,
      audience: `${origin}/orders`,
      clientId: "mcp-client",
      clientSecret: "secret",
    });
    const auth = createFastMcpAuth({ client });
    expect(auth.endpoint).toBe("/orders");
    const fastmcp = new FastMCP<Auth0Session>({
      name: "integration",
      version: "1.0.0",
      logger: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
      ...auth,
    });
    delegateTool(fastmcp);
    await fastmcp.start({
      transportType: "httpStream",
      httpStream: { port, host: "127.0.0.1", stateless: true, endpoint: auth.endpoint },
    });
    try {
      const url = new URL(`${origin}/orders`);
      const challenge = await rawRequest({ url }, { body: { jsonrpc: "2.0", id: 1, method: "ping" } });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toContain(`${origin}/.well-known/oauth-protected-resource/orders`);
      const metadata = await rawRequest({ url }, { method: "GET", path: "/.well-known/oauth-protected-resource/orders" });
      expect(metadata.status).toBe(200);
      expect(((await metadata.json()) as { resource: string }).resource).toBe(`${origin}/orders`);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await fastmcp.stop();
      warn.mockRestore();
    }
  });

  it("warns once when start is given another endpoint than the one the audience names", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const client = createMcpClient({
      domain: DOMAIN,
      audience: `${origin}/orders`,
      clientId: "mcp-client",
      clientSecret: "secret",
    });
    const auth = createFastMcpAuth({ client });
    const fastmcp = new FastMCP<Auth0Session>({
      name: "integration",
      version: "1.0.0",
      logger: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
      ...auth,
    });
    delegateTool(fastmcp);
    await fastmcp.start({
      transportType: "httpStream",
      httpStream: { port, host: "127.0.0.1", stateless: true, endpoint: "/integration-other" },
    });
    try {
      const url = new URL(`${origin}/integration-other`);
      for (let i = 0; i < 3; i++) {
        const response = await rawRequest({ url }, { body: { jsonrpc: "2.0", id: 1, method: "ping" } });
        expect(response.status).toBe(401);
      }
      const messages = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.startsWith("[ai-fastmcp]"));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('"/integration-other"');
      expect(messages[0]).toContain('"/orders"');
    } finally {
      await fastmcp.stop();
      warn.mockRestore();
    }
  });
});
