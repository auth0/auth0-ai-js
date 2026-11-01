/**
 * Smoke test against a real Auth0 tenant. It starts the example's store API and MCP server
 * on loopback, signs a test user in, connects an MCP client over Streamable HTTP, and calls all
 * three tools. The store API verifies the exchanged token against the tenant JWKS, so a passing run
 * proves a real on-behalf-of token arrived.
 *
 * The user token comes from the Resource Owner Password grant. That grant is for local testing
 * only. Production clients should use the authorization code flow with PKCE.
 *
 * Nothing secret is printed: only token lengths and claim names.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decodeJwt } from "jose";
import { loadDownstreamConfig, loadMcpServerConfig } from "../src/config.js";
import { createDownstreamServer } from "../src/downstream-api.js";
import { createMcpApp } from "../src/mcp-app.js";
import { TOOL_SCOPES } from "../src/scopes.js";

const results: { name: string; ok: boolean; detail: string }[] = [];

function record(name: string, ok: boolean, detail = ""): boolean {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Resource Owner Password grant. Local testing only. */
async function signIn(domain: string, audience: string): Promise<string> {
  const body: Record<string, string> = {
    grant_type: process.env["SMOKE_REALM"]?.trim()
      ? "http://auth0.com/oauth/grant-type/password-realm"
      : "password",
    client_id: need("SMOKE_LOGIN_CLIENT_ID"),
    username: need("SMOKE_USERNAME"),
    password: need("SMOKE_PASSWORD"),
    audience,
    scope: process.env["SMOKE_SCOPE"]?.trim() || `openid ${TOOL_SCOPES.join(" ")}`,
  };
  const secret = process.env["SMOKE_LOGIN_CLIENT_SECRET"]?.trim();
  if (secret) body["client_secret"] = secret;
  const realm = process.env["SMOKE_REALM"]?.trim();
  if (realm) body["realm"] = realm;

  const response = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof json["access_token"] !== "string") {
    const code = typeof json["error"] === "string" ? json["error"] : "unknown";
    throw new Error(`Sign-in failed with HTTP ${response.status} (${code}).`);
  }
  return json["access_token"];
}

function resultText(result: unknown): { isError: boolean; text: string } {
  const r = result as { isError?: boolean; content?: { type: string; text?: string }[] };
  const text = (r.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
  return { isError: r.isError === true, text };
}

/** Only the error class and a message the script itself wrote are printed. */
function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const own = error.message.startsWith("Sign-in failed") || error.message.startsWith("Missing environment variable");
  return own ? error.message : error.name;
}

async function main(): Promise<void> {
  let downstream: Server | undefined;
  let mcp: Server | undefined;
  let client: Client | undefined;
  const shutdown = async (): Promise<void> => {
    await client?.close().catch(() => undefined);
    await Promise.all([close(mcp), close(downstream)]);
  };
  // Ctrl-C or a termination signal stops both servers through the same path, then exits non-zero.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(code));
    });
  }
  try {
    // Ports are chosen by the OS, so the smoke never collides with a running server.
    process.env["MCP_PORT"] = "0";
    process.env["DOWNSTREAM_PORT"] = "0";
    const downstreamConfig = loadDownstreamConfig();
    downstream = createDownstreamServer(downstreamConfig);
    const downstreamPort = await listen(downstream);
    process.env["STORE_API_URL"] = `http://127.0.0.1:${downstreamPort}`;

    const config = loadMcpServerConfig();
    const app = createMcpApp(config);
    mcp = createServer((req, res) => void app(req, res));
    const mcpPort = await listen(mcp);
    record("servers started", true, `mcp port ${mcpPort}, store api port ${downstreamPort}`);

    const userToken = await signIn(config.domain, config.serverUrl);
    const claims = decodeJwt(userToken);
    record(
      "user token issued",
      true,
      `length ${userToken.length}, claims ${Object.keys(claims).sort().join(",")}`,
    );

    client = new Client({ name: "smoke-real-tenant", version: "0.1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${userToken}` } },
      }),
    );
    record("mcp client connected", true);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ["fulfill_order", "order_status_report", "sales_analytics_report"];
    record("tools listed", expected.every((n) => names.includes(n)), names.join(","));

    const status = resultText(
      await client.callTool({ name: "order_status_report", arguments: {} }),
    );
    record(
      "order_status_report returned orders fetched with exchanged tokens",
      !status.isError && status.text.includes("ORD-1001") && status.text.includes("Checked by:"),
      status.isError ? "tool error" : "ok",
    );

    const fulfill = resultText(
      await client.callTool({ name: "fulfill_order", arguments: { order_id: "ORD-1002" } }),
    );
    record(
      "fulfill_order reserved stock with an inventory write token",
      !fulfill.isError && fulfill.text.includes("ORD-1002"),
      fulfill.isError ? "tool error" : "ok",
    );

    const analytics = resultText(
      await client.callTool({ name: "sales_analytics_report", arguments: {} }),
    );
    record(
      "sales_analytics_report used the server's own token",
      !analytics.isError && analytics.text.includes("Monthly revenue"),
      analytics.isError ? "tool error" : "ok",
    );
  } catch (error) {
    record("run completed without errors", false, safeMessage(error));
  } finally {
    await shutdown();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
