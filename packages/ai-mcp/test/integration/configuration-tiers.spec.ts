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
  requireClientCredentials,
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
  process.env.AUTH0_CLIENT_ID = ENV_CLIENT.clientId;
  process.env.AUTH0_CLIENT_SECRET = ENV_CLIENT.clientSecret;
}

/**
 * What the environment holds. Different from every inline value used below, and the id and the secret
 * differ from each other, so a swapped or misplaced variable cannot pass for the right one.
 */
const ENV_CLIENT = { clientId: "env-client", clientSecret: "env-secret" };

/** The tenant accepts token requests only from this client; any other id or secret gets a 401. */
function requireClient(client: { clientId: string; clientSecret: string }): void {
  rig().server.use(requireClientCredentials(rig().tenant, client));
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
    requireClient(ENV_CLIENT);
    setEnv(tenant.domain, PATH_AUDIENCE);

    await withApp(
      wiring,
      tenant,
      { useDefaults: true, createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }) },
      async (app) => {
        const suffixed = "/.well-known/oauth-protected-resource/mcp";
        const response = await app.fetch(new URL(suffixed, app.url));
        expect(response.status, suffixed).toBe(200);
        const metadata = (await response.json()) as { resource: string; authorization_servers: string[] };
        expect(metadata.resource).toBe(PATH_AUDIENCE);
        expect(metadata.authorization_servers).toEqual([`https://${tenant.domain}/`]);

        // A resource with a path is described at its suffixed route only; the root route is
        // not served, so it falls through to the authentication check.
        const root = await app.fetch(new URL("/.well-known/oauth-protected-resource", app.url));
        expect(root.status).toBe(401);
        await root.arrayBuffer();

        // HEAD gets the GET headers without a body over the real HTTP server, and a method
        // outside GET and HEAD is told which ones are allowed.
        const head = await app.fetch(new URL(suffixed, app.url), { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-type")).toBe(response.headers.get("content-type"));
        expect(await head.text()).toBe("");
        const post = await app.fetch(new URL(suffixed, app.url), { method: "POST" });
        expect(post.status).toBe(405);
        expect(post.headers.get("allow")).toBe("GET, HEAD");
        expect(post.headers.get("cache-control")).toBe("no-store");
        await post.arrayBuffer();

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
          claims: { azp: "client-a" },
        });
        const outcome = await delegateOnce(app, token);
        expect(outcome.status).toBe(200);
      },
    );
  });

  it("serves a handler built from inline client options", async () => {
    const { tenant } = rig();
    rig().useTenant();
    requireClient({ clientId: "mcp-client", clientSecret: "secret" });

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

  it("completes a partial inline set from the environment, the inline value winning where both exist", async () => {
    const { tenant } = rig();
    rig().useTenant();
    // The id is given inline and also set in the environment; the secret only in the environment.
    requireClient({ clientId: "inline-client", clientSecret: ENV_CLIENT.clientSecret });
    setEnv(tenant.domain);

    await withApp(
      wiring,
      tenant,
      {
        useDefaults: true,
        clientId: "inline-client",
        createServer: () => buildToolServer({ downstreamUrl: tenant.downstreamUrl }),
      },
      async (app) => {
        const outcome = await delegateOnce(app, await rig().token({ scope: "read" }));
        expect(outcome.status).toBe(200);
      },
    );
  });

  it("uses inline client options over a complete environment", async () => {
    const { tenant } = rig();
    rig().useTenant();
    requireClient({ clientId: "inline-client", clientSecret: "inline-secret" });
    setEnv(tenant.domain);

    await withApp(
      wiring,
      tenant,
      {
        useDefaults: true,
        clientId: "inline-client",
        clientSecret: "inline-secret",
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
    requireClient({ clientId: "mcp-client", clientSecret: "secret" });

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
