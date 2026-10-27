/**
 * Settles how the authorization server reports `scope` on a partial grant, a zero grant and a
 * request without a scope, for the three grants the wrapper relies on. The probe table is printed
 * (scope strings, booleans and status codes only, never a token) and asserted, so a change in
 * the authorization server's behaviour fails this spec. The second half drives the same
 * situations through the real handler and checks how the wrapper interprets them.
 *
 * `e2e:undefined` is a scope the API does not define, which the authorization server drops.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  M2M_VARS,
  TOKEN_EXCHANGE_GRANT,
  callToolJson,
  connectMcpClient,
  decodeClaims,
  getUserToken,
  installFetchCounter,
  loadE2eEnv,
  postTokenRequest,
  startDownstreamApi,
  startMcpServer,
} from "./support/index.js";
import type { DelegateResult, DownstreamApi, E2eEnv, E2eMcpServer, FetchCounter } from "./support/index.js";

const e2e = loadE2eEnv(M2M_VARS);

const UNDEFINED_SCOPE = "e2e:undefined";
const PARTIAL = `work:read ${UNDEFINED_SCOPE}`;
/** The scope the login client holds on the MCP API that the password-realm probes use. */
const LOGIN_SCOPE = "tool:whoami";
/** Every scope the login client is granted on the MCP API, in the order the tenant reports them. */
const LOGIN_FULL_GRANT = "tool:whoami tool:delegate tool:order_status_report tool:sales_analytics_report";

type Grant = "password-realm" | "client_credentials" | "token-exchange";
type Case = "partial" | "zero" | "none";

interface ProbeRow {
  grant: Grant;
  requested: Case;
  requestedScope: string | null;
  status: number;
  responseHasScope: boolean;
  responseScope: string | null;
  claimHasScope: boolean;
  claimScope: string | null;
  /** OAuth `error` code of a failed request, or null. */
  error: string | null;
}

/** Posts one token request and reduces the answer to non-secret facts. */
async function probe(
  grant: Grant,
  requested: Case,
  requestedScope: string | null,
  form: Record<string, string>,
): Promise<ProbeRow> {
  const response = await postTokenRequest(e2e, { ...form, ...(requestedScope !== null && { scope: requestedScope }) });
  const body = response.body as { access_token?: string; scope?: unknown; error?: unknown };
  const claims = typeof body.access_token === "string" ? decodeClaims(body.access_token) : {};
  return {
    grant,
    requested,
    requestedScope,
    status: response.status,
    responseHasScope: "scope" in body,
    responseScope: typeof body.scope === "string" ? body.scope : null,
    claimHasScope: "scope" in claims,
    claimScope: typeof claims["scope"] === "string" ? claims["scope"] : null,
    error: typeof body.error === "string" ? body.error : null,
  };
}

/** The three scope requests of one probe: partly granted, not granted at all, and absent. */
const casesFor = (granted: string): Array<[Case, string | null]> => [
  ["partial", `${granted} ${UNDEFINED_SCOPE}`],
  ["zero", UNDEFINED_SCOPE],
  ["none", null],
];

describe("e2e scope reporting on partial and zero grants", () => {
  const rows: ProbeRow[] = [];
  let userToken = "";
  const find = (grant: Grant, requested: Case) => rows.find((r) => r.grant === grant && r.requested === requested)!;

  beforeAll(async () => {
    userToken = await getUserToken(e2e);
    const subjectToken = userToken;
    for (const [name, scope] of casesFor(LOGIN_SCOPE)) {
      rows.push(
        await probe("password-realm", name, scope, {
          grant_type: "http://auth0.com/oauth/grant-type/password-realm",
          realm: e2e.realm,
          username: e2e.username,
          password: e2e.password,
          client_id: e2e.loginClientId,
          client_secret: e2e.loginClientSecret,
          audience: e2e.mcpAudience,
        }),
      );
    }
    for (const [name, scope] of casesFor(e2e.downstreamScope)) {
      rows.push(
        await probe("client_credentials", name, scope, {
          grant_type: "client_credentials",
          client_id: e2e.m2mClientId,
          client_secret: e2e.m2mClientSecret,
          audience: e2e.downstreamAudience,
        }),
      );
    }
    for (const [name, scope] of casesFor(e2e.downstreamScope)) {
      // The same parameters the core sends for an on-behalf-of exchange.
      rows.push(
        await probe("token-exchange", name, scope, {
          grant_type: TOKEN_EXCHANGE_GRANT,
          client_id: e2e.oboClientId,
          client_secret: e2e.oboClientSecret,
          subject_token: subjectToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          audience: e2e.downstreamAudience,
        }),
      );
    }
    const table = rows.map(
      (r) =>
        `${r.grant.padEnd(18)} ${r.requested.padEnd(8)} requested=${JSON.stringify(r.requestedScope)} ` +
        `status=${r.status} error=${r.error ?? "none"} response.scope=${r.responseHasScope ? JSON.stringify(r.responseScope) : "ABSENT"} ` +
        `claim.scope=${r.claimHasScope ? JSON.stringify(r.claimScope) : "ABSENT"}`,
    );
    console.log(`scope probe table\n${table.join("\n")}`);
  });

  // Expected observations. Each row: status, OAuth error (null = none), response scope (null = key
  // absent), claim scope (null = claim absent). The client credentials grant refuses an undefined
  // scope outright (403) instead of dropping it, and defaults an absent scope to the full grant.
  // The other two grants drop an undefined scope: a partial request reports the granted part, a
  // zero request reports an empty string and the token has no `scope` claim.
  type Expected = [status: number, error: string | null, response: string | null, claim: string | null];
  const EXPECTED: Record<Grant, Record<Case, Expected>> = {
    "password-realm": {
      partial: [200, null, LOGIN_SCOPE, LOGIN_SCOPE],
      zero: [200, null, "", null],
      none: [200, null, LOGIN_FULL_GRANT, LOGIN_FULL_GRANT],
    },
    client_credentials: {
      partial: [403, "access_denied", null, null],
      zero: [403, "access_denied", null, null],
      none: [200, null, "work:read", "work:read"],
    },
    "token-exchange": {
      partial: [200, null, "work:read", "work:read"],
      zero: [200, null, "", null],
      none: [200, null, null, null],
    },
  };

  for (const grant of ["password-realm", "client_credentials", "token-exchange"] as const) {
    for (const requested of ["partial", "zero", "none"] as const) {
      it(`${grant} with ${requested} scope reports scope as observed`, () => {
        const row = find(grant, requested);
        const [status, error, response, claim] = EXPECTED[grant][requested];
        expect(row.status).toBe(status);
        expect(row.error).toBe(error);
        expect(row.responseHasScope).toBe(response !== null);
        expect(row.responseScope).toBe(response);
        expect(row.claimHasScope).toBe(claim !== null);
        expect(row.claimScope).toBe(claim);
      });
    }
  }

  describe("wrapper interpretation through the real handler", () => {
    let downstream: DownstreamApi;
    let server: E2eMcpServer | undefined;
    let counter: FetchCounter | undefined;

    beforeAll(async () => {
      downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    });
    beforeEach(async () => {
      counter = installFetchCounter();
      server = await startMcpServer({ env: e2e as E2eEnv, downstreamUrl: downstream.url });
    });
    afterEach(async () => {
      counter?.restore();
      await server?.close();
      server = undefined;
      downstream.calls.length = 0;
    });
    afterAll(async () => {
      await downstream?.close();
    });

    async function delegate(scope: string) {
      const session = await connectMcpClient(server!.url, userToken);
      try {
        counter!.reset();
        return await callToolJson<DelegateResult | string>(session.client, "delegate", { scope });
      } finally {
        await session.close();
      }
    }

    it("treats a partial grant as the downscope outcome and never calls the downstream API", async () => {
      const { isError, value } = await delegate(PARTIAL);
      expect(isError).toBe(true);
      expect(typeof value).toBe("string");
      expect(value as string).toMatch(/did not include all requested scopes/i);
      expect(counter!.exchanges).toBe(1);
      expect(downstream.calls).toEqual([]);
    });

    it("treats a zero grant (empty scope string) as nothing granted, not as granted as requested", async () => {
      const { isError, value } = await delegate(UNDEFINED_SCOPE);
      expect(isError).toBe(true);
      expect(typeof value).toBe("string");
      expect(value as string).toMatch(/did not include all requested scopes/i);
      expect(counter!.exchanges).toBe(1);
      expect(downstream.calls).toEqual([]);
    });

    it("control: a fully granted request is served", async () => {
      const { isError, value } = await delegate("work:read");
      expect(isError).toBe(false);
      expect((value as DelegateResult).grantedScopes).toEqual(["work:read"]);
      expect(downstream.calls.map((c) => c.status)).toEqual([200]);
    });
  });
});
