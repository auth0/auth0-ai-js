/**
 * The tenant's keys or discovery document cannot be fetched while a real caller presents a good
 * token. The core client reports any verification failure as an invalid token, so the adapter
 * answers 401 with a Bearer challenge, from its own fixed text and never the upstream's. These
 * scenarios pin that behavior against the real tenant, so a change in the core is a conscious one,
 * and they check that the same token verifies once the fault is gone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LIBRARY_TEXT,
  describeLive,
  expectNoTokens,
  firstUser,
  installFetchFault,
  postInitialize,
  startDownstreamApi,
  startFastMcpServer,
} from "./support/index.js";
import type { DownstreamApi, FastMcpServer, FetchFault, FetchFaultHandle } from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

const UPSTREAM_SECRET = "e2e-upstream-secret-42";
const UPSTREAM_BODY = { error: "service_unavailable", error_description: UPSTREAM_SECRET };

const CASES: Array<{ name: string; urlIncludes: string; fault: FetchFault }> = [
  { name: "JWKS 503", urlIncludes: "/.well-known/jwks.json", fault: { kind: "status", status: 503, body: UPSTREAM_BODY } },
  { name: "JWKS network error", urlIncludes: "/.well-known/jwks.json", fault: { kind: "network" } },
  {
    name: "discovery 503",
    urlIncludes: "/.well-known/openid-configuration",
    fault: { kind: "status", status: 503, body: UPSTREAM_BODY },
  },
  { name: "discovery network error", urlIncludes: "/.well-known/openid-configuration", fault: { kind: "network" } },
];

describeLive("fastmcp dependency failure on first verification", [], (e2e) => {
  const user = firstUser(e2e);
  let downstream: DownstreamApi;
  let userToken: string;
  let fault: FetchFaultHandle | undefined;
  let server: FastMcpServer | undefined;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await user.token();
  });

  afterEach(async () => {
    fault?.restore();
    await server?.stop();
    fault = undefined;
    server = undefined;
  });

  afterAll(async () => {
    await downstream?.close();
  });

  describe.each(MODES)("$label server", ({ stateless }) => {
    // The core caches discovery metadata and the key set per client after the first success, so each
    // case starts a fresh server with a fresh client, with the fault installed before its first call.
    it.each(CASES)("E-F-01 (pinned behavior) $name: 401 invalid_token with fixed text, then the same token verifies", async (spec) => {
      fault = installFetchFault({ urlIncludes: spec.urlIncludes, method: "GET" }, spec.fault, { times: 1 });
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless });

      const failed = await postInitialize(server, `Bearer ${userToken}`);
      expect(fault.injected).toBe(1);
      expect(failed.status).toBe(401);
      expect(failed.challenge?.scheme).toBe("Bearer");
      expect(failed.challenge?.params["error"]).toBe("invalid_token");
      expect(JSON.parse(failed.body)).toEqual({
        error: "invalid_token",
        error_description: "The access token is invalid or has expired.",
      });
      const text = `${failed.headers.get("www-authenticate") ?? ""}\n${failed.body}`;
      expect(text.includes(UPSTREAM_SECRET), "the response must not echo the upstream body").toBe(false);
      expect(text).not.toMatch(LIBRARY_TEXT);
      expectNoTokens("the response", text, [userToken]);

      // The fault is exhausted and a failed fetch is not cached.
      const retried = await postInitialize(server, `Bearer ${userToken}`);
      expect(retried.status).toBe(200);
      expect(retried.challenge).toBeNull();
    });
  });
});
