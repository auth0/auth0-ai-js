import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDpopProof,
  callToolJson,
  connectMcpClient,
  generateDpopKeyPair,
  getUserToken,
  loadE2eEnv,
  parseChallenge,
  postInitialize,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { DownstreamApi, DpopKeyPair, E2eMcpServer } from "./support/index.js";

const e2e = loadE2eEnv();

/** POSTs an MCP initialize with arbitrary headers; reports status, challenge and body text. */
async function post(url: URL, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e-probe", version: "1.0.0" } },
    }),
  });
  const text = await response.text();
  const header = response.headers.get("www-authenticate");
  return { status: response.status, header, challenge: header === null ? null : parseChallenge(header), text };
}

describe("e2e DPoP negatives with an unbound tenant token", () => {
  let downstream: DownstreamApi;
  let required: E2eMcpServer;
  let allowed: E2eMcpServer;
  let userToken: string;
  let keys: DpopKeyPair;

  beforeAll(async () => {
    userToken = await getUserToken(e2e);
    keys = await generateDpopKeyPair();
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    required = await startMcpServer({ env: e2e, downstreamUrl: downstream.url, dpop: { mode: "required" } });
    allowed = await startMcpServer({ env: e2e, downstreamUrl: downstream.url });
  });

  afterAll(async () => {
    await required?.close();
    await allowed?.close();
    await downstream?.close();
  });

  it("the token under test carries no cnf binding", () => {
    const payload = JSON.parse(Buffer.from(userToken.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("cnf");
  });

  it("required mode treats a Bearer credential as absent and advertises only DPoP", async () => {
    const res = await post(required.url, { authorization: `Bearer ${userToken}` });
    expect(res.status).toBe(401);
    expect(res.challenge?.scheme).toBe("DPoP");
    expect(res.challenge?.params["algs"]).toBe("ES256");
    // RFC 6750 section 3.1: no error value, because the request lacked the supported authentication.
    expect(res.challenge?.params).not.toHaveProperty("error");
    expect(/Bearer/.test(res.header ?? ""), "challenge must advertise only DPoP").toBe(false);
    expect(res.text.includes(userToken), "response body must not echo the credential").toBe(false);
  });

  it("required mode without any header advertises DPoP", async () => {
    const res = await postInitialize(required.url);
    expect(res.status).toBe(401);
    expect(res.challenge?.scheme).toBe("DPoP");
    expect(res.challenge?.params["algs"]).toBe("ES256");
    expect(res.challenge?.params).not.toHaveProperty("error");
  });

  it.each([
    ["required", () => required],
    ["allowed", () => allowed],
  ])("%s mode rejects the DPoP scheme with a valid proof for an unbound token", async (_mode, pick) => {
    const server = pick();
    const proof = await buildDpopProof(keys, { htm: "POST", htu: server.htu, accessToken: userToken });
    const res = await post(server.url, { authorization: `DPoP ${userToken}`, dpop: proof });
    expect(res.status).toBe(401);
    // The binding check fails first (no cnf), so the error is invalid_token, not invalid_dpop_proof.
    // Allowed mode sends two challenges (Bearer first, then DPoP); the error rides on the DPoP one.
    expect(/DPoP error="invalid_token"/.test(res.header ?? ""), "DPoP challenge carries invalid_token").toBe(true);
    expect(/Bearer [^,]*error=/.test(res.header ?? ""), "Bearer challenge carries no error").toBe(false);
    expect((res.header ?? "").includes(proof), "challenge header must not echo the proof").toBe(false);
    expect((res.header ?? "").includes(userToken), "challenge header must not echo the credential").toBe(false);
    expect(res.text.includes(proof), "response body must not echo the proof").toBe(false);
    expect(res.text.includes(userToken), "response body must not echo the credential").toBe(false);
  });

  it("rejects a proof that is not a JWT with a 400 invalid_request challenge", async () => {
    const res = await post(required.url, { authorization: `DPoP ${userToken}`, dpop: "not-a-jwt" });
    expect(res.status).toBe(400);
    expect(res.challenge?.scheme).toBe("DPoP");
    expect(res.challenge?.params["error"]).toBe("invalid_request");
  });

  it("rejects a well-formed proof with a wrong htu (the unbound token is still what fails)", async () => {
    const proof = await buildDpopProof(keys, { htm: "POST", htu: "https://elsewhere.example/mcp", accessToken: userToken });
    const res = await post(required.url, { authorization: `DPoP ${userToken}`, dpop: proof });
    expect(res.status).toBe(401);
    expect(res.challenge?.scheme).toBe("DPoP");
    expect(res.challenge?.params["error"]).toBe("invalid_token");
  });

  it.todo("answers invalid_dpop_proof for a bad proof (needs a tenant client that issues cnf.jkt tokens: with an unbound token the binding check fails first)");

  it("allowed mode (default) still accepts an unbound Bearer token", async () => {
    const session = await connectMcpClient(allowed.url, userToken);
    try {
      const { isError, value } = await callToolJson<{ sub: string }>(session.client, "whoami");
      expect(isError).toBe(false);
      expect(value.sub).toMatch(/\|/);
    } finally {
      await session.close();
    }
  });

  it.todo("accepts a DPoP-bound token with a valid proof (needs a tenant client that issues cnf.jkt tokens)");
});
