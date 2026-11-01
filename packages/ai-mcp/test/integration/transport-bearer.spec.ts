import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { createTestKey, mintAccessToken } from "../support/index.js";
import {
  AUDIENCE,
  ORIGIN,
  WIRINGS,
  buildToolServer,
  callJson,
  connectClient,
  createRig,
  makeMcpClient,
  rawToolCall,
  withApp,
} from "./harness.js";
import type { Seen } from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

const PRM = `${ORIGIN}/.well-known/oauth-protected-resource`;

async function refused(attempt: Promise<unknown>): Promise<{ status: number | undefined; seen: Seen[] }> {
  const error = (await attempt.then(
    () => {
      throw new Error("The connection was expected to be refused.");
    },
    (e: unknown) => e,
  )) as { status?: number; seen: Seen[] };
  return { status: error.status, seen: error.seen };
}

describe.each(WIRINGS)("bearer authentication through the SDK client (%s wiring)", (wiring) => {
  async function run<T>(fn: (url: Parameters<typeof connectClient>[0]) => Promise<T>) {
    const { tenant } = rig();
    rig().useTenant();
    return withApp(
      wiring,
      tenant,
      {
        client: makeMcpClient(tenant),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      },
      fn,
    );
  }

  it("answers 401 with a bare challenge when no credential is sent", async () => {
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app));

      expect(status).toBe(401);
      const challenge = seen[0]!.wwwAuthenticate!;
      expect(challenge.startsWith(`Bearer resource_metadata="${PRM}"`)).toBe(true);
      expect(challenge).not.toContain("error=");
    });
  });

  it("answers 401 invalid_token for a token that is not a JWT", async () => {
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app, "not-a.valid.token"));

      expect(status).toBe(401);
      expect(seen[0]!.wwwAuthenticate).toContain('error="invalid_token"');
      expect(seen[0]!.wwwAuthenticate).toContain(`resource_metadata="${PRM}"`);
    });
  });

  it("answers 401 invalid_token for a token with the tenant's key id but another signature", async () => {
    const { tenant } = rig();
    // The key id matches the tenant key, so the key lookup succeeds and only the signature check can refuse.
    const other = await createTestKey({ kid: tenant.key.kid });
    const forged = await mintAccessToken(other, { iss: tenant.auth0.issuer, aud: AUDIENCE, sub: "user|1" });
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app, forged));

      expect(status).toBe(401);
      expect(seen[0]!.wwwAuthenticate).toContain('error="invalid_token"');
    });
  });

  it("answers 401 invalid_token for a token signed with a key the tenant does not publish", async () => {
    const { tenant } = rig();
    const other = await createTestKey();
    const forged = await mintAccessToken(other, { iss: tenant.auth0.issuer, aud: AUDIENCE, sub: "user|1" });
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app, forged));

      expect(status).toBe(401);
      expect(seen[0]!.wwwAuthenticate).toContain('error="invalid_token"');
    });
  });

  it("answers 401 invalid_token for an expired token", async () => {
    const expired = await rig().token({ exp: Math.floor(Date.now() / 1000) - 120 });
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app, expired));

      expect(status).toBe(401);
      expect(seen[0]!.wwwAuthenticate).toContain('error="invalid_token"');
    });
  });

  it("answers 401 invalid_token for a token issued for another audience", async () => {
    const wrongAudience = await mintAccessToken(rig().tenant.key, {
      iss: rig().tenant.auth0.issuer,
      aud: "https://other.example.com",
      sub: "user|1",
    });
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app, wrongAudience));

      expect(status).toBe(401);
      expect(seen[0]!.wwwAuthenticate).toContain('error="invalid_token"');
    });
  });

  it("does not echo verifier messages in the challenge or the body", async () => {
    await run(async (app) => {
      const { seen } = await refused(connectClient(app, "not-a.valid.token"));

      const description = /error_description="([^"]*)"/.exec(seen[0]!.wwwAuthenticate!)?.[1] ?? "";
      expect(description).not.toMatch(/jwt|jws|signature|payload|jose/i);
    });
  });

  it("answers 400 invalid_request for a malformed Authorization header", async () => {
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app, { authorization: "Bearer two tokens" }));

      expect(status).toBe(400);
      expect(seen[0]!.wwwAuthenticate).toContain('error="invalid_request"');
    });
  });

  it("answers 401 without an error value for an unsupported scheme", async () => {
    await run(async (app) => {
      const { status, seen } = await refused(connectClient(app, { authorization: "Basic dXNlcjpwYXNz" }));

      expect(status).toBe(401);
      expect(seen[0]!.wwwAuthenticate).not.toContain("error=");
    });
  });

  it("lets a valid token reach the tool with the caller's identity", async () => {
    await run(async (app) => {
      const session = await connectClient(app, await rig().token({ sub: "user|valid" }));
      try {
        const tools = await session.client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["whoami", "delegate"]));

        const { isError, value } = await callJson<{ contextSub: string; clientSub: string }>(session, "whoami");

        expect(isError).toBe(false);
        expect(value).toMatchObject({ contextSub: "user|valid", clientSub: "user|valid", clientId: "client-a" });
        // The SDK client opens a GET for an SSE stream after initialize. The handler serves POST
        // only and answers 405, which the client treats as "no stream" without retrying.
        const gets = session.seen.filter((r) => r.status === 405);
        expect(gets.length).toBeLessThanOrEqual(1);
        expect(session.seen.filter((r) => r.method !== "GET").every((r) => r.status === 200 || r.status === 202)).toBe(
          true,
        );
        expect(gets.every((r) => r.method === "GET")).toBe(true);
        expect(session.seen.every((r) => r.status === 200 || r.status === 202 || r.status === 405)).toBe(true);
      } finally {
        await session.close();
      }
    });
  });

  it("mints Auth0's default token profile in these suites: azp, with no client_id, sid or jti", async () => {
    const claims = decodeJwt(await rig().token());

    expect(claims["azp"]).toBe("client-a");
    expect(claims).not.toHaveProperty("client_id");
    expect(claims).not.toHaveProperty("sid");
    expect(claims).not.toHaveProperty("jti");
  });

  it.each([
    ["azp only", { azp: "client-a" }, "client-a"],
    ["client_id only", { client_id: "client-b" }, "client-b"],
    ["both, where azp is preferred", { azp: "client-a", client_id: "client-b" }, "client-a"],
    ["neither", {}, null],
  ])("reports the calling client to the tool from %s", async (_label, claims, expected) => {
    await run(async (app) => {
      const session = await connectClient(app, await rig().token({ claims }));
      try {
        const { isError, value } = await callJson<{ clientId: string | null }>(session, "whoami");

        expect(isError).toBe(false);
        expect(value.clientId).toBe(expected);
      } finally {
        await session.close();
      }
    });
  });

  it("forwards only a verifiable, correctly scoped token downstream", async () => {
    await run(async (app) => {
      const session = await connectClient(app, await rig().token({ sub: "user|valid" }));
      try {
        const { value } = await callJson<{ status: number; body: { ok: boolean; sub: string; scopes: string[] } }>(
          session,
          "delegate",
        );

        expect(value.status).toBe(200);
        expect(value.body).toMatchObject({ ok: true, sub: "user|valid", scopes: ["api:read"] });
        expect(rig().tenant.oracle.calls).toHaveLength(1);
        rig().assertAllForwardedTokensVerified();
      } finally {
        await session.close();
      }
    });
  });

  it("never runs a tool or an exchange for a rejected request", async () => {
    await run(async (app) => {
      await refused(connectClient(app, "not-a.valid.token"));

      expect(rig().tenant.auth0.state.exchangeCount).toBe(0);
      expect(rig().tenant.oracle.calls).toHaveLength(0);
    });
  });

  describe("a tools/call sent on its own, without the handshake", () => {
    // The server keeps no session, so every request stands alone and must carry its own credential.
    // A refused connect only shows that the first request was refused; these send the call itself.
    const CREDENTIALS = ["no credential", "a token that is not a JWT", "a token with a forged signature"] as const;

    async function authorizationFor(credential: (typeof CREDENTIALS)[number]): Promise<string | undefined> {
      if (credential === "no credential") return undefined;
      if (credential === "a token that is not a JWT") return "Bearer not-a.valid.token";
      const { tenant } = rig();
      // The tenant's key id, so the key lookup succeeds and only the signature check can refuse.
      const forged = await mintAccessToken(await createTestKey({ kid: tenant.key.kid }), {
        iss: tenant.auth0.issuer,
        aud: AUDIENCE,
        sub: "user|1",
      });
      return `Bearer ${forged}`;
    }

    it("is served for a valid token, so the refusals below are about the credential", async () => {
      await run(async (app) => {
        const response = await rawToolCall(app, `Bearer ${await rig().token({ sub: "user|valid" })}`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as { result?: { isError?: boolean } };
        expect(body.result?.isError).not.toBe(true);
        expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(1);
      });
    });

    it.each(CREDENTIALS)("answers 401 and exchanges nothing for %s", async (credential) => {
      const authorization = await authorizationFor(credential);
      await run(async (app) => {
        const response = await rawToolCall(app, authorization);

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(0);
        expect(rig().tenant.oracle.calls).toHaveLength(0);
      });
    });
  });
});
