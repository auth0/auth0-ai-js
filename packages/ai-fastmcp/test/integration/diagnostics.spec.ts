import { FastMCP } from "fastmcp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withAuth0Execute } from "../../src/index.js";
import type { Auth0Session } from "../../src/index.js";
import { DOWNSTREAM, callTool, connect, createRig, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

const MODES = [{ stateless: true }, { stateless: false }];

function delegateTool(server: FastMCP<Auth0Session>, options?: Parameters<typeof withAuth0Execute>[1]): void {
  server.addTool({
    name: "delegate",
    description: "Exchanges the caller's token.",
    parameters: z.object({}),
    execute: withAuth0Execute(async (_args, ctx) => {
      await ctx.session.mcpClient.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: "api:read" });
      return "unreachable";
    }, options),
  });
}

describe.each(MODES)("failure reporting through a real FastMCP server (stateless: $stateless)", ({ stateless }) => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
  });

  it("writes the default log line with Auth0's error and nothing the client can see", async () => {
    await withServer({ stateless, tools: (server) => delegateTool(server) }, async (server) => {
      rig().tenant.auth0.state.failure = {
        status: 403,
        body: { error: "access_denied", error_description: "Client has no grant for the audience" },
      };
      const session = await connect(server, await rig().token(server));
      try {
        const outcome = await callTool(session, "delegate");
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toMatch(/^(Tool execution failed\.|The token operation failed\.)$/);
        expect(outcome.text).not.toContain("access_denied");
        const lines = error.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[ai-fastmcp]"));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("auth0_error=access_denied");
        expect(lines[0]).toContain('auth0_error_description="Client has no grant for the audience"');
        expect(lines[0]).not.toContain(rig().tenant.auth0.issuer);
      } finally {
        await session.close();
      }
    });
  });

  it("gives the server-level onError the raw error of a tool that has no hook of its own", async () => {
    const seen: unknown[] = [];
    await withServer(
      { stateless, auth: { onError: (e) => void seen.push(e) }, tools: (server) => delegateTool(server) },
      async (server) => {
        rig().tenant.auth0.state.failure = { status: 400, body: { error: "invalid_grant", error_description: "bad" } };
        const session = await connect(server, await rig().token(server));
        try {
          const outcome = await callTool(session, "delegate");
          expect(outcome.isError).toBe(true);
          expect(seen).toHaveLength(1);
          expect(seen[0]).toBeInstanceOf(Error);
          expect(error.mock.calls.filter((call) => String(call[0]).startsWith("[ai-fastmcp]"))).toHaveLength(0);
        } finally {
          await session.close();
        }
      },
    );
  });

  it("lets the hook of one tool replace the server-level one", async () => {
    const serverSide : unknown[] = [];
    const tool: unknown[] = [];
    await withServer(
      {
        stateless,
        auth: { onError: (e) => void serverSide.push(e) },
        tools: (server) => delegateTool(server, { onError: (e) => void tool.push(e) }),
      },
      async (server) => {
        rig().tenant.auth0.state.failure = { status: 500 };
        const session = await connect(server, await rig().token(server));
        try {
          await callTool(session, "delegate");
          expect(tool).toHaveLength(1);
          expect(serverSide).toHaveLength(0);
        } finally {
          await session.close();
        }
      },
    );
  });
});
