import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, delay, http } from "msw";
import { WIRINGS, buildToolServer, connectClient, createRig, makeMcpClient, withApp } from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

const TIMEOUT_MS = 200;

describe.each(WIRINGS)("a hung discovery or JWKS endpoint at ingress (%s wiring)", (wiring) => {
  async function refusedWith(endpoint: "jwks" | "discovery") {
    const { tenant, server } = rig();
    rig().useTenant();
    const path = endpoint === "jwks" ? tenant.auth0.jwksUri : `https://${tenant.domain}/.well-known/openid-configuration`;
    server.use(
      http.get(path, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );
    const token = await rig().token();
    return withApp(
      wiring,
      tenant,
      {
        client: makeMcpClient(tenant, { requestTimeoutMs: TIMEOUT_MS }),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      },
      async (app) => {
        const started = Date.now();
        const error = (await connectClient(app, token).then(
          () => {
            throw new Error("The connection was expected to be refused.");
          },
          (e: unknown) => e,
        )) as { code?: number; seen: { wwwAuthenticate?: string }[] };
        return { code: error.code, challenge: error.seen[0]?.wwwAuthenticate, elapsed: Date.now() - started };
      },
    );
  }

  it.each(["jwks", "discovery"] as const)(
    "currently answers 401 invalid_token, not 500, when %s never responds",
    async (endpoint) => {
      const { code, challenge, elapsed } = await refusedWith(endpoint);

      expect(elapsed).toBeLessThan(TIMEOUT_MS * 10);
      expect(code).toBe(401);
      expect(challenge).toContain('error="invalid_token"');
    },
  );
});
