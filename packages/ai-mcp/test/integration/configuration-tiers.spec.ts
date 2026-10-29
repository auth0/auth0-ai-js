import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMcpSdkHandler } from "../../src/mcp-sdk.js";
import { InvalidConfigurationError } from "@auth0/auth0-api-js";
import { mintAccessToken } from "../support/index.js";
import {
  AUDIENCE,
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

const ENV_NAMES = ["AUTH0_DOMAIN", "AUTH0_AUDIENCE", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"] as const;
const saved: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>> = {};

beforeEach(() => {
  for (const name of ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** An audience with a path, so the handler serves a suffixed and a root metadata route. */
const PATH_AUDIENCE = `${ORIGIN}/mcp`;

function setEnv(domain: string, audience = AUDIENCE): void {
  process.env.AUTH0_DOMAIN = domain;
  process.env.AUTH0_AUDIENCE = audience;
  process.env.AUTH0_CLIENT_ID = "mcp-client";
  process.env.AUTH0_CLIENT_SECRET = "secret";
}

async function refusal(app: Parameters<typeof connectClient>[0]) {
  return (await connectClient(app).then(
    () => {
      throw new Error("The connection was expected to be refused.");
    },
    (e: unknown) => e,
  )) as { status?: number; seen: Array<{ wwwAuthenticate: string | null }> };
}

describe.each(WIRINGS)("handler configuration tiers (%s wiring)", (wiring) => {
  it("serves a handler built with only createServer and the environment", async () => {
    const { tenant } = rig();
    rig().useTenant();
    setEnv(tenant.domain, PATH_AUDIENCE);

    await withApp(
      wiring,
      tenant,
      { useDefaults: true, createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }) },
      async (app) => {
        for (const path of [
          "/.well-known/oauth-protected-resource/mcp",
          "/.well-known/oauth-protected-resource",
        ]) {
          const response = await app.fetch(new URL(path, app.url));
          expect(response.status, path).toBe(200);
          const metadata = (await response.json()) as { resource: string; authorization_servers: string[] };
          expect(metadata.resource).toBe(PATH_AUDIENCE);
          expect(metadata.authorization_servers).toEqual([`https://${tenant.domain}/`]);
        }

        const error = await refusal(app);
        expect(error.status).toBe(401);
        const advertised = /resource_metadata="([^"]+)"/.exec(error.seen[0]!.wwwAuthenticate!)?.[1];
        expect(advertised).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
        const resolved = await app.fetch(new URL(new URL(advertised!).pathname, app.url));
        expect(resolved.status).toBe(200);
        expect(((await resolved.json()) as { resource: string }).resource).toBe(PATH_AUDIENCE);

        const token = await mintAccessToken(tenant.key, {
          iss: tenant.auth0.issuer,
          aud: PATH_AUDIENCE,
          sub: "user|1",
          scope: "read",
          claims: { client_id: "client-a" },
        });
        const outcome = await delegateOnce(app, token);
        expect(outcome.status).toBe(200);
      },
    );
  });

  it("serves a handler built from inline client options", async () => {
    const { tenant } = rig();
    rig().useTenant();

    await withApp(
      wiring,
      tenant,
      {
        useDefaults: true,
        domain: tenant.domain,
        audience: AUDIENCE,
        clientId: "mcp-client",
        clientSecret: "secret",
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      },
      async (app) => {
        const response = await app.fetch(new URL("/.well-known/oauth-protected-resource", app.url));
        expect(response.status).toBe(200);
        expect(((await response.json()) as { resource: string }).resource).toBe(ORIGIN);
        expect((await refusal(app)).status).toBe(401);
        const outcome = await delegateOnce(app, await rig().token({ scope: "read" }));
        expect(outcome.body.ok).toBe(true);
      },
    );
  });

  it("completes a partial inline set from the environment", async () => {
    const { tenant } = rig();
    rig().useTenant();
    setEnv(tenant.domain);

    await withApp(
      wiring,
      tenant,
      {
        useDefaults: true,
        clientId: "mcp-client",
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      },
      async (app) => {
        const outcome = await delegateOnce(app, await rig().token({ scope: "read" }));
        expect(outcome.status).toBe(200);
      },
    );
  });

  it("serves a handler built from a shared client", async () => {
    const { tenant } = rig();
    rig().useTenant();

    await withApp(
      wiring,
      tenant,
      {
        useDefaults: true,
        client: makeMcpClient(tenant),
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      },
      async (app) => {
        const response = await app.fetch(new URL("/.well-known/oauth-protected-resource", app.url));
        expect(response.status).toBe(200);
        const outcome = await delegateOnce(app, await rig().token({ scope: "read" }));
        expect(outcome.body.ok).toBe(true);
      },
    );
  });
});

describe("handler configuration errors", () => {
  it("rejects a client combined with inline client options, naming only the options", async () => {
    const { tenant } = rig();
    const create = () =>
      createMcpSdkHandler({
        client: makeMcpClient(tenant),
        clientId: "other-client",
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      } as never);

    expect(create).toThrow(InvalidConfigurationError);
    expect(create).toThrow(/"client" cannot be combined with "clientId"/);
    expect(create).not.toThrow(/other-client|secret/);
  });

  it("rejects an explicit resource that differs from the audience at construction", async () => {
    const { tenant } = rig();
    const create = () =>
      createMcpSdkHandler({
        client: makeMcpClient(tenant),
        resource: "https://other.example.com",
        authorizationServers: [tenant.auth0.issuer],
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      });

    expect(create).toThrow(InvalidConfigurationError);
    expect(create).not.toThrow(/other\.example\.com/);
  });

  it("reports a trailing slash as a difference", async () => {
    const { tenant } = rig();
    const create = () =>
      createMcpSdkHandler({
        client: makeMcpClient(tenant),
        resource: `${AUDIENCE}/`,
        authorizationServers: [tenant.auth0.issuer],
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      });

    expect(create).toThrow(/trailing slash/);
  });
});
