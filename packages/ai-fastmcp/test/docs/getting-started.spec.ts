import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastMCP } from "fastmcp";
import { DOMAIN, createRig, freePort, socketFetch } from "../integration/harness.js";
import { documented, loadSnippet, snippetCode } from "./guides.js";
import type { LoadedSnippet } from "./guides.js";

/** Pins every claim of docs/GettingStarted.md. The server in the guide is run as written. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("GettingStarted.md", () => {
  let port: number;
  let origin: string;
  let loaded: LoadedSnippet;
  let server: FastMCP<never>;
  let restoreEnv: (() => void) | undefined;

  beforeAll(async () => {
    port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    // The guide exports AUTH0_DOMAIN and AUTH0_AUDIENCE and nothing else.
    const saved = {
      AUTH0_DOMAIN: process.env["AUTH0_DOMAIN"],
      AUTH0_AUDIENCE: process.env["AUTH0_AUDIENCE"],
      AUTH0_CLIENT_ID: process.env["AUTH0_CLIENT_ID"],
      AUTH0_CLIENT_SECRET: process.env["AUTH0_CLIENT_SECRET"],
    };
    process.env["AUTH0_DOMAIN"] = DOMAIN;
    process.env["AUTH0_AUDIENCE"] = `${origin}/mcp`;
    delete process.env["AUTH0_CLIENT_ID"];
    delete process.env["AUTH0_CLIENT_SECRET"];
    restoreEnv = () => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
    loaded = await loadSnippet("GettingStarted.md", 1, {
      rewrites: [["port: 3000", `host: "127.0.0.1", port: ${port}`]],
      exportNames: ["server"],
    });
    server = loaded.exports["server"] as FastMCP<never>;
  });

  afterAll(async () => {
    await server?.stop();
    loaded?.dispose();
    restoreEnv?.();
  });

  async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return socketFetch(`${origin}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(body) });
  }

  it("keeps the server in the guide under 20 lines", () => {
    expect(snippetCode("GettingStarted.md", 1).trim().split("\n").length).toBeLessThan(20);
    documented("GettingStarted.md", "# Getting started", "Create `server.ts`:");
    documented("README.md", "a server in under 20 lines");
  });

  it("answers a request without a token with 401, a Bearer challenge that names the metadata, and the documented body", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge.startsWith("Bearer")).toBe(true);
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    const body = await response.text();
    expect(body).toBe('{"error":"unauthorized","error_description":"Authentication is required."}');
    documented(
      "GettingStarted.md",
      "starts with `Bearer` and names the metadata document",
      '{"error":"unauthorized","error_description":"Authentication is required."}',
    );
  });

  it("serves the tool to a caller with a token, with no initialize call first, as one data line", async () => {
    const token = await rig().token({ audience: `${origin}/mcp` }, { sub: "auth0|abc123" });
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } },
      { authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBe('data: {"result":{"content":[{"type":"text","text":"auth0|abc123"}]},"jsonrpc":"2.0","id":1}');
    documented(
      "GettingStarted.md",
      'data: {"result":{"content":[{"type":"text","text":"',
      '"}]},"jsonrpc":"2.0","id":1}',
      "A stateless FastMCP server needs no `initialize` call first.",
      "you must set `AUTH0_DOMAIN` and `AUTH0_AUDIENCE`, and `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` matter only to tools that exchange tokens",
    );
  });

  it("publishes the metadata document on both routes, without a token, in the documented shape", async () => {
    const suffixed = await socketFetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    const root = await socketFetch(`${origin}/.well-known/oauth-protected-resource`);
    expect(suffixed.status).toBe(200);
    expect(root.status).toBe(200);
    const raw = await suffixed.text();
    expect(raw).toBe(`{"resource":"${origin}/mcp","authorization_servers":["https://${DOMAIN}/"],"bearer_methods_supported":["header"]}`);
    expect(await root.text()).toBe(raw);
    documented(
      "GettingStarted.md",
      raw.replace(`${origin}/mcp`, "http://localhost:3000/mcp").replace(`https://${DOMAIN}/`, "https://your-tenant.us.auth0.com/"),
      "Both routes are public",
    );
  });

  it("names FastMCP 4.7.0 as the oldest release and the other guides it links", () => {
    documented("GettingStarted.md", "The oldest FastMCP release supported is 4.7.0", "(./Compatibility.md)");
  });
});
