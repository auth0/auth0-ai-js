import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as aiMcp from "@auth0/ai-mcp";
import {
  INITIALIZE_BODY,
  callTool,
  connect,
  createRig,
  parseMessage,
  rawRequest,
  withServer,
} from "../integration/harness.js";
import { documented, guideText, packageDir } from "./guides.js";
import { FLOOR, compareVersions, installedFastmcpVersion, parseVersion } from "./versions.js";

/** Pins every claim of docs/Compatibility.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const GUIDE = "Compatibility.md";

function manifest(): {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
}

describe("Compatibility.md: FastMCP", () => {
  it("declares ^4.7.0 as the peer range, and the suites run inside it", () => {
    expect(manifest().peerDependencies["fastmcp"]).toBe("^4.7.0");
    expect(FLOOR).toEqual([4, 7, 0]);
    const installed = parseVersion(installedFastmcpVersion());
    expect(compareVersions(installed, FLOOR)).toBeGreaterThanOrEqual(0);
    expect(installed[0]).toBe(4);
    documented(GUIDE, "The peer dependency range is `^4.7.0`. 4.7.0 is the oldest release supported.");
  });

  it("puts an _meta field on a tool error, with one of the three documented kinds, which is why the floor is 4.7.0", async () => {
    await withServer({}, async (server) => {
      const session = await connect(server, await rig().token(server, { scope: "x" }));
      try {
        const denied = await callTool(session, "admin"); // insufficient_scope
        const failed = await callTool(session, "throws"); // server_error
        expect(denied.isError).toBe(true);
        expect(denied.meta).toEqual({ error: "insufficient_scope" });
        expect(failed.meta).toEqual({ error: "server_error" });
      } finally {
        await session.close();
      }
    });
    documented(
      GUIDE,
      "an `_meta` field that carries the kind of error (`insufficient_scope`, `invalid_token` or `server_error`)",
      "FastMCP releases before 4.7.0 reject `_meta` in a tool result.",
      "`Tool '<name>' execution failed:` and contains `Unrecognized key: \"_meta\"`",
    );
  });

  it("fails a direct call to a hidden tool with Unknown tool and one of two JSON-RPC codes", async () => {
    await withServer({}, async (server) => {
      const response = await rawRequest(server, {
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hidden", arguments: {} } },
        headers: { authorization: `Bearer ${await rig().token(server, { scope: "read:orders" })}` },
      });
      const message = parseMessage(await response.text()) as { error: { code: number; message: string } };
      expect(message.error.message).toContain("Unknown tool");
      expect([-32601, -32602]).toContain(message.error.code);
    });
    documented(
      GUIDE,
      "fails with the JSON-RPC code -32601 on some 4.x releases and -32602 on others. In both cases the message contains `Unknown tool`, provided the caller can see at least one other tool.",
    );
  });

  it("lists the releases the matrix covered, with the floor first and the newest tried last", () => {
    const text = guideText(GUIDE);
    for (const row of [
      "| 4.7.0 (the floor) | Pass |",
      "| 4.10.0, 4.13.0, 4.16.0, 4.19.0, 4.21.0, 4.22.0, 4.23.0 | Pass |",
      "| 4.23.8 (the newest tried) | Pass |",
      "| 4.0.0, 4.3.0, 4.4.0, 4.5.0, 4.6.0 | Fail, because of `_meta` |",
    ]) {
      expect(text).toContain(row);
    }
    expect(text).toContain("These are samples, not every patch release. 4.1 and 4.2 were not run.");
  });
});

describe("Compatibility.md: protocol revisions", () => {
  const REVISIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

  it.each(REVISIONS)("answers an initialize request for %s with the same revision", async (protocolVersion) => {
    await withServer({}, async (server) => {
      const response = await rawRequest(server, {
        body: { ...INITIALIZE_BODY, params: { ...INITIALIZE_BODY.params, protocolVersion } },
        headers: { authorization: `Bearer ${await rig().token(server)}` },
      });
      const message = parseMessage(await response.text()) as { result: { protocolVersion: string } };
      expect(message.result.protocolVersion).toBe(protocolVersion);
    });
  });

  it("answers an initialize request for a newer revision with 2025-11-25", async () => {
    await withServer({}, async (server) => {
      const response = await rawRequest(server, {
        body: { ...INITIALIZE_BODY, params: { ...INITIALIZE_BODY.params, protocolVersion: "2099-01-01" } },
        headers: { authorization: `Bearer ${await rig().token(server)}` },
      });
      const message = parseMessage(await response.text()) as { result: { protocolVersion: string } };
      expect(message.result.protocolVersion).toBe("2025-11-25");
    });
    documented(
      GUIDE,
      "2025-03-26, 2025-06-18 and 2025-11-25.",
      "FastMCP answers an `initialize` request for a newer revision with 2025-11-25.",
    );
  });

  it("makes no claim about any revision beyond the three", () => {
    expect(guideText(GUIDE)).not.toMatch(/2026-/);
    for (const name of ["README.md"]) expect(guideText(name)).not.toMatch(/2026-/);
  });
});

describe("Compatibility.md: the client, the transports and @auth0/ai-mcp", () => {
  it("tests with the v2 MCP client, version 2.3 or later", () => {
    expect(manifest().devDependencies["@modelcontextprotocol/client"]).toBe("^2.3.0");
    const candidates = [
      path.join(packageDir, "node_modules", "@modelcontextprotocol", "client", "package.json"),
      path.join(packageDir, "..", "..", "node_modules", "@modelcontextprotocol", "client", "package.json"),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    expect(file).toBeDefined();
    const version = parseVersion((JSON.parse(readFileSync(file!, "utf8")) as { version: string }).version);
    expect(compareVersions(version, [2, 3, 0])).toBeGreaterThanOrEqual(0);
    expect(version[0]).toBe(2);
    documented(GUIDE, "(`@modelcontextprotocol/client`, version 2.3 or later)");
  });

  it("is tested over the httpStream transport in both modes", async () => {
    for (const stateless of [true, false]) {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server));
        try {
          expect((await callTool<{ sessionSub: string }>(session, "whoami")).value.sessionSub).toBe("user|1");
        } finally {
          await session.close();
        }
      });
    }
    documented(GUIDE, "The tests cover only FastMCP's `httpStream` transport, in both its stateless and stateful modes.");
  });

  it("uses @auth0/ai-mcp as a peer with the range * and calls the functions the guide names", () => {
    expect(manifest().peerDependencies["@auth0/ai-mcp"]).toBe("*");
    for (const name of [
      "authenticateRequest",
      "buildProtectedResourceMetadata",
      "buildWwwAuthenticate",
      "runWithRequestContext",
      "getCallerPrincipal",
      "getCallerMcpClient",
      "getCallerMcpClientOrThrow",
    ] as const) {
      expect(typeof aiMcp[name], name).toBe("function");
    }
    documented(
      GUIDE,
      "`@auth0/ai-mcp` is a peer dependency with the range `*`",
      "`authenticateRequest`, `buildProtectedResourceMetadata`, `buildWwwAuthenticate` and the request context functions",
    );
  });
});
