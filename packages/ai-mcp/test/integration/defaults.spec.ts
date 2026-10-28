import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ORIGIN,
  WIRINGS,
  buildToolServer,
  connectClient,
  createRig,
  delegateOnce,
  makeMcpClient,
  withApp,
} from "./harness.js";

const { rig, install } = createRig();
install({ beforeAll, afterEach, afterAll });

describe.each(WIRINGS)("handler built from only the client and createServer (%s wiring)", (wiring) => {
  function run<T>(fn: (app: Parameters<typeof connectClient>[0]) => Promise<T>) {
    const { tenant } = rig();
    rig().useTenant();
    return withApp(
      wiring,
      tenant,
      {
        useDefaults: true,
        client: makeMcpClient(tenant),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      },
      fn,
    );
  }

  it("serves metadata for the client audience and the tenant issuer", async () => {
    const { tenant } = rig();
    await run(async (app) => {
      const response = await app.fetch(new URL("/.well-known/oauth-protected-resource", app.url));

      expect(response.status).toBe(200);
      const metadata = (await response.json()) as { resource: string; authorization_servers: string[] };
      expect(metadata.resource).toBe(ORIGIN);
      expect(metadata.authorization_servers).toEqual([`https://${tenant.domain}/`]);
    });
  });

  it("answers 401 with a resource_metadata url that serves the metadata", async () => {
    await run(async (app) => {
      const error = (await connectClient(app).then(
        () => {
          throw new Error("The connection was expected to be refused.");
        },
        (e: unknown) => e,
      )) as { status?: number; seen: Array<{ wwwAuthenticate: string | null }> };

      expect(error.status).toBe(401);
      const challenge = error.seen[0]!.wwwAuthenticate!;
      const advertised = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
      expect(advertised).toBe(`${ORIGIN}/.well-known/oauth-protected-resource`);

      const response = await app.fetch(new URL(new URL(advertised!).pathname, app.url));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { resource: string }).resource).toBe(ORIGIN);
    });
  });

  it("authenticates and delegates a valid token", async () => {
    await run(async (app) => {
      const outcome = await delegateOnce(app, await rig().token({ scope: "read" }));

      expect(outcome.status).toBe(200);
      expect(outcome.body.ok).toBe(true);
    });
  });
});
