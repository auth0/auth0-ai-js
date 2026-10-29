/**
 * Organization policy at ingress for real signed-in users. The member of organization A signs in
 * through Universal Login with the authorization code flow and PKCE (client credentials cannot
 * stand in for a person who signs in through an organization). The user is a member of
 * organization A only, so a token for organization B comes from the organization tester client
 * (client credentials with `organization`), which is a real token from the tenant, not a forged
 * one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_USER_VARS,
  callToolJson,
  connectMcpClient,
  decodeClaims,
  getClientCredentialsToken,
  getUserToken,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { DownstreamApi, E2eMcpServer } from "./support/index.js";
import { AuthCodeLoginError } from "./support/auth-code-login.js";
import { loginOrgUser } from "./support/auth-code-token.js";

const e2e = loadE2eEnv(ORG_USER_VARS);

describe("e2e organization users", () => {
  let downstream: DownstreamApi;
  let userTokenA: string;
  let tokenB: string;
  let noOrgToken: string;
  const servers: E2eMcpServer[] = [];

  const start = async (options: { organizationId?: string | string[] } = {}) => {
    const server = await startMcpServer({
      env: e2e,
      downstreamUrl: downstream.url,
      organizationPolicy: "required",
      ...options,
    });
    servers.push(server);
    return server;
  };

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userTokenA = (await loginOrgUser(e2e, { organization: e2e.orgAId })).accessToken;
    tokenB = await getClientCredentialsToken(e2e, {
      audience: e2e.mcpAudience,
      organization: e2e.orgBId,
      clientId: e2e.orgTesterClientId,
      clientSecret: e2e.orgTesterClientSecret,
    });
    noOrgToken = await getUserToken(e2e);
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    await downstream?.close();
  });

  it("E-O-01 a user signed in through organization A passes a required policy and the tool sees org A", async () => {
    // The token really is a user token for org A, not a machine token.
    const claims = decodeClaims(userTokenA);
    expect(claims["org_id"]).toBe(e2e.orgAId);
    expect(claims["sub"]).not.toMatch(/@clients$/);

    const server = await start({ organizationId: [e2e.orgAId] });
    const session = await connectMcpClient(server.url, userTokenA);
    try {
      const { isError, value } = await callToolJson<{ orgId: string | null; sub: string }>(session.client, "whoami");
      expect(isError).toBe(false);
      expect(value.orgId).toBe(e2e.orgAId);
      expect(value.sub).toBe(claims["sub"]);
    } finally {
      await session.close();
    }
  });

  it("E-O-01 pinned-tenant: exchanging an organization-bound user token is refused while the exchange client does not allow organizations", async () => {
    // Observed on the tenant: the exchange of a token that carries org_id answers 400 invalid_request
    // "parameter organization is not allowed for this client". The tool must report a generic
    // failure and leak neither the tenant message nor the organization. When the exchange client is
    // given organization usage this test turns red and should become a positive check that the
    // downstream token carries org_id.
    const server = await start({ organizationId: [e2e.orgAId] });
    const session = await connectMcpClient(server.url, userTokenA);
    try {
      const { isError, value } = await callToolJson<unknown>(session.client, "delegate");
      expect(isError).toBe(true);
      const text = JSON.stringify(value);
      expect(text).not.toContain(e2e.orgAId);
      expect(text.toLowerCase()).not.toContain("not allowed for this client");
    } finally {
      await session.close();
    }
  });

  it("E-O-02 a token of organization B is refused by an allow-list of A with 401 invalid_token and no org id echoed", async () => {
    // Control: the token is a genuine organization B token and the policy tells A from B.
    expect(decodeClaims(tokenB)["org_id"]).toBe(e2e.orgBId);

    const onlyA = await start({ organizationId: [e2e.orgAId] });
    const refused = await postInitialize(onlyA.url, `Bearer ${tokenB}`);
    expect(refused.status).toBe(401);
    expect(refused.challenge?.scheme).toBe("Bearer");
    expect(refused.challenge?.params["error"]).toBe("invalid_token");
    const header = refused.wwwAuthenticate ?? "";
    expect(header.includes(e2e.orgAId), "challenge must not echo the allowed org id").toBe(false);
    expect(header.includes(e2e.orgBId), "challenge must not echo the caller org id").toBe(false);

    const onlyB = await start({ organizationId: [e2e.orgBId] });
    expect((await postInitialize(onlyB.url, `Bearer ${tokenB}`)).status).toBe(200);
  });

  it("E-O-02 the tenant itself refuses to sign the organization A member in through organization B", async () => {
    // Pinned tenant behavior: membership is enforced at /authorize, so no org B user token exists.
    const err = await loginOrgUser(e2e, { organization: e2e.orgBId }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthCodeLoginError);
    expect((err as AuthCodeLoginError).message).toContain("access_denied");
  });

  it("E-O-03 a user with no organization hits a required policy and gets 401 invalid_token", async () => {
    expect(decodeClaims(noOrgToken)).not.toHaveProperty("org_id");
    for (const options of [{}, { organizationId: [e2e.orgAId] }]) {
      const server = await start(options);
      const res = await postInitialize(server.url, `Bearer ${noOrgToken}`);
      expect(res.status).toBe(401);
      expect(res.challenge?.params["error"]).toBe("invalid_token");
    }
  });
});
