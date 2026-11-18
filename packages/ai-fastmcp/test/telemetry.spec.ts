import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { ApiClient } from "@auth0/auth0-api-js";
import { InvalidConfigurationError } from "@auth0/ai-mcp";
import type { McpClient } from "@auth0/ai-mcp";
import { resolveClient } from "../src/options.js";
import { PACKAGE_NAME, VERSION } from "../src/version.js";
import { createAuth0Handlers, createTestKey, mintAccessToken } from "./support/index.js";
import type { TestKey } from "./support/index.js";

const AUDIENCE = "https://mcp.example.com";
const DOWNSTREAM = "https://downstream.example.com/resource";

interface Seen {
  kind: "discovery" | "jwks" | "token";
  header: string | null;
}

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers> = undefined as never;
let seen: Seen[] = [];
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    const kind = url.pathname.includes("openid-configuration")
      ? "discovery"
      : url.href === tenant.jwksUri
        ? "jwks"
        : url.href === tenant.tokenEndpoint
          ? "token"
          : undefined;
    if (kind !== undefined) seen.push({ kind, header: request.headers.get("auth0-client") });
  });
});
afterEach(() => {
  server.resetHandlers();
  seen = [];
});
afterAll(() => server.close());

function useTenant(): void {
  tenant = createAuth0Handlers({ key });
  server.use(...tenant.handlers);
}

function decode(header: string | null): Record<string, unknown> {
  return JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as Record<string, unknown>;
}

async function exerciseAll(client: McpClient): Promise<void> {
  const accessToken = await mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: "user|1", scope: "openid" });
  const caller = await client.verifyAccessToken({ accessToken });
  const scoped = client.withToken(caller);
  await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });
  await scoped.getClientCredentialsToken({ audience: DOWNSTREAM });
}

const INLINE = { domain: "tenant.example.com", audience: AUDIENCE, clientId: "mcp-client", clientSecret: "secret" };

describe("telemetry identity of a client built by the adapter", () => {
  it("sends @auth0/ai-fastmcp with its version and the core env on token, discovery and JWKS requests", async () => {
    useTenant();
    await exerciseAll(resolveClient(INLINE).client);

    expect(PACKAGE_NAME).toBe("@auth0/ai-fastmcp");
    expect(new Set(seen.map((s) => s.kind))).toEqual(new Set(["discovery", "jwks", "token"]));
    for (const request of seen) {
      const data = decode(request.header);
      expect(data.name).toBe("@auth0/ai-fastmcp");
      expect(data.version).toBe(VERSION);
      expect(data.env).toEqual({ "@auth0/auth0-api-js": expect.stringMatching(/^\d+\.\d+\.\d+/) });
    }
  });

  it("forwards telemetry { enabled: false } unchanged and sends no header", async () => {
    useTenant();
    await exerciseAll(resolveClient({ ...INLINE, telemetry: { enabled: false } }).client);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.header === null)).toBe(true);
  });

  it("lets a caller supplied identity win", async () => {
    useTenant();
    await exerciseAll(resolveClient({ ...INLINE, telemetry: { name: "my-server", version: "3.2.1" } }).client);

    for (const request of seen) {
      expect(decode(request.header)).toMatchObject({ name: "my-server", version: "3.2.1" });
    }
  });

  it("adds no telemetry to a supplied apiClient, so apiClient alone is still accepted", async () => {
    useTenant();
    const apiClient = new ApiClient({ domain: "tenant.example.com", audience: AUDIENCE });
    const { client } = resolveClient({ domain: "tenant.example.com", audience: AUDIENCE, apiClient });
    const accessToken = await mintAccessToken(key, { iss: tenant.issuer, aud: AUDIENCE, sub: "user|1", scope: "openid" });

    await client.verifyAccessToken({ accessToken });

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(decode(request.header).name).not.toBe("@auth0/ai-fastmcp");
  });

  it("rejects apiClient combined with an explicit telemetry option", () => {
    const apiClient = new ApiClient({ domain: "tenant.example.com", audience: AUDIENCE });
    expect(() =>
      resolveClient({ domain: "tenant.example.com", audience: AUDIENCE, apiClient, telemetry: { enabled: false } }),
    ).toThrow(InvalidConfigurationError);
  });

  it("rejects client combined with telemetry", () => {
    const { client } = resolveClient(INLINE);
    expect(() => resolveClient({ client, telemetry: { enabled: false } } as never)).toThrow(InvalidConfigurationError);
  });
});
