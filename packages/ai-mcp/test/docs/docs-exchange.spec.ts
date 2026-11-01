import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { createMcpClient } from "../../src/index.js";
import type { McpClient, TokenStore } from "../../src/index.js";
import { createAuth0Handlers, createTestKey, mintAccessToken, scopeMode } from "../support/index.js";
import type { MintAccessTokenOptions, TestKey } from "../support/index.js";

/**
 * Pins statements of the guides that depend on how the real core client and the tenant
 * answer. Auth0 is replaced by MSW.
 */

const AUDIENCE = "https://mcp.example.com/mcp";
const DOWNSTREAM = "https://reports-api.example.com";

let key: TestKey;
let tenant: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  tenant = createAuth0Handlers({ key, scope: scopeMode.echo });
  server.listen({ onUnhandledRequest: "error" });
  server.use(...tenant.handlers);
});
afterEach(() => {
  tenant.state.reset();
});
afterAll(() => server.close());

function makeClient(tokenStore?: TokenStore): McpClient {
  return createMcpClient({
    domain: "tenant.example.com",
    audience: AUDIENCE,
    clientId: "mcp-client",
    clientSecret: "secret",
    ...(tokenStore !== undefined && { tokenStore }),
  });
}

async function callerFor(client: McpClient, token: Omit<MintAccessTokenOptions, "iss" | "aud"> = {}) {
  const accessToken = await mintAccessToken(key, {
    iss: tenant.issuer,
    aud: AUDIENCE,
    sub: "user|1",
    scope: "mcp:access",
    ...token,
  });
  return client.withToken(await client.verifyAccessToken({ accessToken, scheme: "bearer" }));
}

describe("an exchange without scope (OnBehalfOf.md)", () => {
  it("sends no scope, accepts the answer without one and reports an empty grant", async () => {
    tenant.state.scope = scopeMode.absent;
    const scoped = await callerFor(makeClient());

    const result = await scoped.getTokenOnBehalfOf({ audience: DOWNSTREAM });

    expect(tenant.state.lastExchangeRequest?.params["scope"]).toBeUndefined();
    expect(result.scope).toBeUndefined();
    expect(result.grantedScopes).toEqual([]);
  });
});
