import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import { createMcpClient } from "@auth0/ai-mcp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFastMcpAuth } from "../../src/index.js";
import { withEnv } from "../support/stubs.js";
import { DOMAIN, INITIALIZE_BODY, callTool, connect, createRig, rawRequest, startServer, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

describe.each([{ stateless: true }, { stateless: false }])("client configuration tiers (stateless: $stateless)", ({ stateless }) => {
  for (const configuration of ["client", "inline", "env"] as const) {
    it(`serves an authenticated tool call with the ${configuration} tier, including an exchange`, async () => {
      await withServer({ stateless, configuration }, async (server) => {
        const session = await connect(server, await rig().token(server, { sub: "user|alice" }));
        try {
          expect((await callTool<{ sessionSub: string }>(session, "whoami")).value.sessionSub).toBe("user|alice");
          const delegated = await callTool<{ status: number; sub: string }>(session, "delegate");
          expect(delegated.value).toMatchObject({ status: 200, sub: "user|alice" });
        } finally {
          await session.close();
        }
      });
    });

    it(`refuses a request without a token with the ${configuration} tier`, async () => {
      await withServer({ stateless, configuration }, async (server) => {
        const response = await rawRequest(server, { body: INITIALIZE_BODY });
        expect(response.status).toBe(401);
      });
    });
  }
});

describe("configuration errors", () => {
  it("throws when a client is combined with inline client options and names only the option", () => {
    const client = createMcpClient({ domain: DOMAIN, audience: "http://127.0.0.1:1/mcp" });
    const attempt = () =>
      createFastMcpAuth({ client, clientSecret: "super-secret-value" } as unknown as Parameters<typeof createFastMcpAuth>[0]);
    expect(attempt).toThrow(InvalidConfigurationError);
    expect(attempt).toThrow('"client" cannot be combined with "clientSecret"');
    expect(attempt).not.toThrow(/super-secret-value/);
  });

  it("throws at construction, not on the first request, when the environment lacks the audience", async () => {
    await withEnv({ AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: undefined }, () => {
      expect(() => createFastMcpAuth({})).toThrow(/"audience".*AUTH0_AUDIENCE/);
    });
  });

  it("lets the environment complete a partial inline set", async () => {
    await withEnv({ AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: "http://127.0.0.1:4000/mcp" }, () => {
      const auth = createFastMcpAuth({ clientId: "mcp-client" });
      expect(auth.oauth.protectedResource.resource).toBe("http://127.0.0.1:4000/mcp");
    });
  });

  it("throws for an explicit resource that differs from the audience", async () => {
    await expect(startServer({ auth: { resource: "http://127.0.0.1:1/mcp" } })).rejects.toThrow(InvalidConfigurationError);
  });

  it("accepts an explicit resource that equals the audience", () => {
    const auth = createFastMcpAuth({
      domain: DOMAIN,
      audience: "http://127.0.0.1:4000/mcp",
      resource: "http://127.0.0.1:4000/mcp",
    });
    expect(auth.oauth.protectedResource.resource).toBe("http://127.0.0.1:4000/mcp");
  });

  it("refuses a client that requires DPoP", async () => {
    await expect(startServer({ clientOptions: { dpop: { mode: "required" } } })).rejects.toThrow(/DPoP mode "required"/);
  });
});
