import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callToolJson,
  connectMcpClient,
  getUserToken,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import { decodeClaims } from "./support/tokens.js";
import type { DownstreamApi, E2eMcpServer } from "./support/index.js";

const e2e = loadE2eEnv();

/** A scope of the MCP API itself, which the signed-in test user holds. */
const CALLER_SCOPE = "tool:whoami";

describe("e2e ingress", () => {
  let downstream: DownstreamApi;
  let server: E2eMcpServer;
  let userToken: string;
  let wrongAudienceToken: string;

  beforeAll(async () => {
    downstream = await startDownstreamApi({
      domain: e2e.domain,
      audience: e2e.downstreamAudience,
    });
    server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url });
    userToken = await getUserToken(e2e, { scope: CALLER_SCOPE });
    wrongAudienceToken = await getUserToken(e2e, {
      audience: e2e.downstreamAudience,
    });
  });

  afterAll(async () => {
    await server?.close();
    await downstream?.close();
  });

  it("serves a tool call for a valid token", async () => {
    const session = await connectMcpClient(server.url, userToken);
    try {
      const { isError, value } = await callToolJson<{
        sub: string;
        scopes: string[];
      }>(session.client, "whoami");
      expect(isError).toBe(false);
      expect(value.sub).toMatch(/\|/);
      expect(value.scopes).toContain(CALLER_SCOPE);
    } finally {
      await session.close();
    }
  });

  it("answers a missing Authorization header with a bare Bearer challenge", async () => {
    const res = await postInitialize(server.url);
    expect(res.status).toBe(401);
    expect(res.challenge?.scheme).toBe("Bearer");
    expect(res.challenge?.params["resource_metadata"]).toMatch(
      /^https?:\/\/.+oauth-protected-resource/,
    );
    // RFC 6750 section 3.1: no error code when the request lacked any authentication.
    expect(res.challenge?.params).not.toHaveProperty("error");
  });

  it("rejects a garbage token with invalid_token", async () => {
    const res = await postInitialize(server.url, "Bearer not.a.token");
    expect(res.status).toBe(401);
    expect(res.challenge?.params["error"]).toBe("invalid_token");
  });

  it("rejects a tenant-signed token issued for another audience", async () => {
    const res = await postInitialize(
      server.url,
      `Bearer ${wrongAudienceToken}`,
    );
    expect(res.status).toBe(401);
    expect(res.challenge?.params["error"]).toBe("invalid_token");
  });

  it.skipIf(e2e.expiredToken === "")(
    "rejects an expired token (skipped: needs an expired tenant-issued token, see README)",
    async () => {
      const exp = decodeClaims(e2e.expiredToken)["exp"];
      expect(
        typeof exp,
        "supplied expired token must carry a numeric exp claim",
      ).toBe("number");
      expect(
        (exp as number) < Math.floor(Date.now() / 1000),
        "the supplied AUTH0_E2E_EXPIRED_TOKEN is not expired",
      ).toBe(true);
      const res = await postInitialize(
        server.url,
        `Bearer ${e2e.expiredToken}`,
      );
      expect(res.status).toBe(401);
      expect(res.challenge?.params["error"]).toBe("invalid_token");
    },
  );

  it("answers a token without the required scope with 403 insufficient_scope", async () => {
    const strict = await startMcpServer({
      env: e2e,
      downstreamUrl: downstream.url,
      requiredScopes: ["e2e:never-granted"],
    });
    try {
      const res = await postInitialize(strict.url, `Bearer ${userToken}`);
      expect(res.status).toBe(403);
      expect(res.challenge?.params["error"]).toBe("insufficient_scope");
      expect(res.challenge?.params["scope"]).toContain("e2e:never-granted");
    } finally {
      await strict.close();
    }
  });
});
