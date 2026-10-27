import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  callToolJson,
  connectMcpClient,
  getUserToken,
  installFetchCounter,
  loadE2eEnv,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { DelegateResult, DownstreamApi, DownstreamClaimsBody, E2eMcpServer, FetchCounter } from "./support/index.js";

const e2e = loadE2eEnv();

describe("e2e on-behalf-of exchange", () => {
  let downstream: DownstreamApi;
  let server: E2eMcpServer | undefined;
  let counter: FetchCounter | undefined;
  let userToken: string;
  let userSub: string;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await getUserToken(e2e);
  });

  // The counter goes in before the server so any fetch reference taken at construction is wrapped.
  beforeEach(async () => {
    counter = installFetchCounter();
    server = await startMcpServer({ env: e2e, downstreamUrl: downstream.url });
  });

  afterEach(async () => {
    counter?.restore();
    await server?.close();
    server = undefined;
    downstream.calls.length = 0;
  });

  afterAll(async () => {
    await downstream.close();
  });

  it("exchanges for the downstream audience and the downstream API verifies the token", async () => {
    const session = await connectMcpClient(server!.url, userToken);
    try {
      const who = await callToolJson<{ sub: string }>(session.client, "whoami");
      userSub = who.value.sub;
      counter!.reset();

      const { isError, value } = await callToolJson<DelegateResult>(session.client, "delegate", {
        scope: "work:read",
      });
      expect(isError).toBe(false);
      expect(value.status).toBe(200);

      const claims = value.body as unknown as DownstreamClaimsBody;
      expect(claims.ok).toBe(true);
      expect(claims.aud).toEqual(e2e.downstreamAudience);
      expect(claims.sub).toBe(userSub);
      expect(claims.scope?.split(" ")).toContain("work:read");
      // Actor chain: the exchanging client acts, on behalf of the login client that holds the user token.
      expect(claims.act?.sub).toBe(e2e.oboClientId);
      expect(claims.act?.act?.sub).toBe(e2e.loginClientId);

      expect(downstream.calls.map((c) => c.status)).toEqual([200]);
      expect(counter!.exchanges).toBe(1);
    } finally {
      await session.close();
    }
  });
});
