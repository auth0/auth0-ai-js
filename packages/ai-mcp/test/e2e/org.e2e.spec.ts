/**
 * Organization policy at ingress, driven by client credentials tokens from the organization tester
 * client: a token minted with `organization` carries `org_id`, one minted without it does not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_USER_VARS,
  callToolJson,
  connectMcpClient,
  decodeClaims,
  getClientCredentialsToken,
  loadE2eEnv,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { DownstreamApi, E2eMcpServer } from "./support/index.js";

const e2e = loadE2eEnv(ORG_USER_VARS);

/** A well-formed organization id that is not the tenant's. */
const OTHER_ORG = "org_e2eNotThisOrganization";

describe("e2e organization policy", () => {
  let downstream: DownstreamApi;
  let withOrg: string;
  let withoutOrg: string;
  const servers: E2eMcpServer[] = [];

  const start = async (options: { organizationId?: string | string[] }) => {
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
    const tester = { clientId: e2e.orgTesterClientId, clientSecret: e2e.orgTesterClientSecret };
    withOrg = await getClientCredentialsToken(e2e, { audience: e2e.mcpAudience, organization: e2e.orgAId, ...tester });
    withoutOrg = await getClientCredentialsToken(e2e, { audience: e2e.mcpAudience, ...tester });
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    await downstream?.close();
  });

  it("the minted tokens differ in the org_id claim as the scenarios assume", () => {
    expect(decodeClaims(withOrg)["org_id"]).toBe(e2e.orgAId);
    expect(decodeClaims(withoutOrg)).not.toHaveProperty("org_id");
  });

  it("serves a token of an allowed organization and exposes org_id to the tool", async () => {
    const server = await start({ organizationId: [e2e.orgAId] });
    const session = await connectMcpClient(server.url, withOrg);
    try {
      const { isError, value } = await callToolJson<{ orgId: string | null; sub: string }>(session.client, "whoami");
      expect(isError).toBe(false);
      expect(value.orgId).toBe(e2e.orgAId);
      expect(value.sub).toMatch(/@clients$/);
    } finally {
      await session.close();
    }
  });

  it("serves a token with an organization when the policy has no allowlist", async () => {
    const server = await start({});
    const session = await connectMcpClient(server.url, withOrg);
    try {
      const { isError, value } = await callToolJson<{ orgId: string | null }>(session.client, "whoami");
      expect(isError).toBe(false);
      expect(value.orgId).toBe(e2e.orgAId);
    } finally {
      await session.close();
    }
  });

  it("rejects a token without an organization with 401 invalid_token", async () => {
    const server = await start({ organizationId: [e2e.orgAId] });
    const res = await postInitialize(server.url, `Bearer ${withoutOrg}`);
    expect(res.status).toBe(401);
    expect(res.challenge?.scheme).toBe("Bearer");
    expect(res.challenge?.params["error"]).toBe("invalid_token");
  });

  it("rejects a token without an organization when the policy has no allowlist", async () => {
    const server = await start({});
    const res = await postInitialize(server.url, `Bearer ${withoutOrg}`);
    expect(res.status).toBe(401);
    expect(res.challenge?.params["error"]).toBe("invalid_token");
  });

  it("rejects a token of an organization missing from the allowlist with 401 invalid_token", async () => {
    const server = await start({ organizationId: [OTHER_ORG] });
    const res = await postInitialize(server.url, `Bearer ${withOrg}`);
    expect(res.status).toBe(401);
    expect(res.challenge?.params["error"]).toBe("invalid_token");
    // The challenge must not reveal which organizations the server accepts.
    expect((res.wwwAuthenticate ?? "").includes(OTHER_ORG), "challenge must not echo the org id").toBe(false);
    expect((res.wwwAuthenticate ?? "").includes(e2e.orgAId), "challenge must not echo the org id").toBe(false);
  });

  it("accepts the organization when it is one of several allowed", async () => {
    const server = await start({ organizationId: [OTHER_ORG, e2e.orgAId] });
    const res = await postInitialize(server.url, `Bearer ${withOrg}`);
    expect(res.status).toBe(200);
  });
});
