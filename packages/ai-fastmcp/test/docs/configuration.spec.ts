import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { ApiClient, InvalidConfigurationError } from "@auth0/auth0-api-js";
import { MemoryIndexedTokenStore, createMcpClient } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import type { FastMcpAuthBaseOptions } from "../../src/index.js";
import {
  DOMAIN,
  callTool,
  connect,
  createRig,
  freePort,
  parseChallenge,
  rawRequest,
  socketFetch,
  withServer,
} from "../integration/harness.js";
import { fakeRequest, bearer, stubClient, thrown } from "../support/stubs.js";
import { documented, guideText, loadSnippet } from "./guides.js";
import { startDocsServer, withEnv } from "./server.js";

/** Pins every claim of docs/Configuration.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

async function status(server: { url: URL; audience: string }, token?: string, path?: string): Promise<number> {
  const response = await rawRequest(server, {
    body: LIST,
    ...(token !== undefined && { headers: { authorization: `Bearer ${token}` } }),
    ...(path !== undefined && { path }),
  });
  return response.status;
}

describe("Configuration.md: the three ways to configure the client", () => {
  it.each(["client", "inline", "env"] as const)("serves a valid token with the %s tier", async (configuration) => {
    await withServer({ configuration }, async (server) => {
      const session = await connect(server, await rig().token(server, { sub: "user|tier" }));
      try {
        const outcome = await callTool<{ sessionSub: string }>(session, "whoami");
        expect(outcome.value.sessionSub).toBe("user|tier");
      } finally {
        await session.close();
      }
    });
    documented("Configuration.md", "**A client you built.**", "**Inline options.**", "**The environment.**");
  });

  it("reads a value left out of the inline options from the environment", async () => {
    const calls: string[] = [];
    const server = await withEnv({ AUTH0_CLIENT_ID: "env-client", AUTH0_CLIENT_SECRET: "env-secret" }, () =>
      startDocsServer({
        auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
        tools: (s) => {
          s.addTool({
            name: "exchange",
            parameters: z.object({}),
            execute: withAuth0Execute(async (_args, { session }) => {
              await session!.mcpClient.getTokenOnBehalfOf({ audience: "https://api.example.com", scope: "api:read" });
              calls.push("done");
              return "ok";
            }),
          });
        },
      }),
    );
    try {
      const session = await connect(server, await rig().token(server));
      try {
        await callTool(session, "exchange");
      } finally {
        await session.close();
      }
      expect(calls).toEqual(["done"]);
      expect(rig().tenant.auth0.state.lastExchangeRequest?.clientId).toBe("env-client");
    } finally {
      await server.stop();
    }
    documented("Configuration.md", "Anything you leave out of `domain`, `audience`, `clientId` and `clientSecret` is read from the environment");
  });

  it("names the four variables and when each is needed", () => {
    documented(
      "Configuration.md",
      "| `AUTH0_DOMAIN` | Always.",
      "| `AUTH0_AUDIENCE` | Always.",
      "| `AUTH0_CLIENT_ID` | Only when a tool exchanges tokens. |",
      "| `AUTH0_CLIENT_SECRET` | Only when a tool exchanges tokens. |",
    );
  });

  it("throws InvalidConfigurationError for a missing domain or audience and names the option and the variable", async () => {
    const empty = { AUTH0_DOMAIN: undefined, AUTH0_AUDIENCE: undefined, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: undefined };
    await withEnv(empty, () => {
      expect(() => createFastMcpAuth({})).toThrow(InvalidConfigurationError);
      expect(() => createFastMcpAuth({})).toThrow(/Missing MCP client option "domain".*AUTH0_DOMAIN/);
    });
    await withEnv({ ...empty, AUTH0_DOMAIN: DOMAIN }, () => {
      expect(() => createFastMcpAuth({})).toThrow(/Missing MCP client option "audience".*AUTH0_AUDIENCE/);
    });
    await withEnv({ ...empty, AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: "https://mcp.example.com/mcp" }, () => {
      // The client id and secret are not needed to build the adapter.
      expect(() => createFastMcpAuth({})).not.toThrow();
    });
    documented(
      "Configuration.md",
      "A missing `domain` or `audience` throws `InvalidConfigurationError`",
      '`Missing MCP client option "domain"`',
      "A server that only verifies tokens does not need the client id and secret.",
    );
  });

  it("refuses a client combined with an inline client option and names the option", () => {
    const client = createMcpClient({ domain: DOMAIN, audience: "https://mcp.example.com/mcp" });
    const call = () => createFastMcpAuth({ client, domain: DOMAIN } as never);
    expect(call).toThrow(InvalidConfigurationError);
    expect(call).toThrow('Invalid configuration: "client" cannot be combined with "domain". Pass either a client or client options.');
    documented(
      "Configuration.md",
      'Invalid configuration: "client" cannot be combined with "domain". Pass either a client or client options.',
    );
  });

  it("accepts every other client option inline", () => {
    const base = { domain: DOMAIN, audience: "https://mcp.example.com/mcp" };
    const options: Array<Record<string, unknown>> = [
      { tokenStore: new MemoryIndexedTokenStore() },
      { scopeMatching: "strict" },
      { organizationPolicy: "required" },
      { organizationPolicy: "required", organizationId: "org_1" },
      { requestTimeoutMs: 2000 },
      { apiClient: new ApiClient({ domain: DOMAIN, audience: "https://mcp.example.com/mcp" }) },
    ];
    for (const extra of options) {
      expect(() => createFastMcpAuth({ ...base, ...extra } as never), JSON.stringify(Object.keys(extra))).not.toThrow();
    }
    documented(
      "Configuration.md",
      "`tokenStore`, `scopeMatching`, `organizationPolicy`, `organizationId`, `requestTimeoutMs` and `apiClient`",
    );
  });

  it("enforces an organization policy given inline: a token without org_id gets 401", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, organizationPolicy: "required" }),
    });
    try {
      expect(await status(server, await rig().token(server))).toBe(401);
      expect(await status(server, await rig().token(server, { claims: { org_id: "org_1" } }))).toBe(200);
    } finally {
      await server.stop();
    }
    documented("Configuration.md", '`organizationPolicy: "required"` makes the adapter answer 401 to a token without an `org_id` claim');
  });
});

describe("Configuration.md: the resource, the audience and the endpoint", () => {
  const client = () => createMcpClient({ domain: DOMAIN, audience: "https://mcp.example.com/mcp" });

  it("defaults the resource to the audience", async () => {
    await withServer({}, async (server) => {
      const document = (await (await socketFetch(`${server.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as {
        resource: string;
      };
      expect(document.resource).toBe(server.audience);
    });
    documented("Configuration.md", "Leave it out and it defaults to the audience.");
  });

  it("accepts an explicit resource equal to the audience and refuses any other", () => {
    expect(() => createFastMcpAuth({ client: client(), resource: "https://mcp.example.com/mcp" })).not.toThrow();
    expect(() => createFastMcpAuth({ client: client(), resource: "https://other.example.com/mcp" })).toThrow(InvalidConfigurationError);
    // A trailing slash counts as a difference.
    expect(() => createFastMcpAuth({ client: client(), resource: "https://mcp.example.com/mcp/" })).toThrow(InvalidConfigurationError);
    documented(
      "Configuration.md",
      "If you set it, it must equal the audience, and `createFastMcpAuth` throws `InvalidConfigurationError` when it does not.",
    );
  });

  it("cannot serve an audience that is not an absolute http or https URL", () => {
    expect(() => createFastMcpAuth({ domain: DOMAIN, audience: "urn:acme:mcp" })).toThrow(InvalidConfigurationError);
    expect(() => createFastMcpAuth({ domain: DOMAIN, audience: "my-mcp-server" })).toThrow(InvalidConfigurationError);
    documented("Configuration.md", "An audience that is not an absolute `http` or `https` URL, such as `urn:acme:mcp`, cannot be served and throws the same error.");
  });

  it("serves the MCP route and the metadata at a custom endpoint, as the guide's snippet does", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const loaded = await loadSnippet("Configuration.md", 4, {
      rewrites: [
        ['"https://mcp.example.com/api/mcp"', JSON.stringify(`${origin}/api/mcp`)],
        ['"your-tenant.us.auth0.com"', JSON.stringify(DOMAIN)],
        ["port: 3000", `host: "127.0.0.1", port: ${port}`],
      ],
      exportNames: ["server"],
    });
    const server = loaded.exports["server"] as FastMCP<never>;
    try {
      const target = { url: new URL(`${origin}/api/mcp`), audience: `${origin}/api/mcp` };
      const unauthenticated = await rawRequest(target, { body: LIST });
      expect(unauthenticated.status).toBe(401);
      const challenge = parseChallenge(unauthenticated.headers.get("www-authenticate"));
      expect(challenge.params["resource_metadata"]).toBe(`${origin}/.well-known/oauth-protected-resource/api/mcp`);
      for (const path of ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource"]) {
        const response = await socketFetch(`${origin}${path}`);
        expect(response.status, path).toBe(200);
        expect(((await response.json()) as { resource: string }).resource).toBe(`${origin}/api/mcp`);
      }
      const token = await rig().token(target);
      expect(await status(target, token)).toBe(200);
    } finally {
      await server.stop();
      loaded.dispose();
    }
    documented(
      "Configuration.md",
      "`/.well-known/oauth-protected-resource/api/mcp`",
      "It defaults to `/mcp`.",
    );
  });

  it("refuses a resource path that is neither empty nor the endpoint, with the documented message", () => {
    const call = () => createFastMcpAuth({ client: client(), endpoint: "/other" });
    expect(call).toThrow(InvalidConfigurationError);
    expect(call).toThrow('the path of "resource" ("/mcp") must equal "endpoint" ("/other") or be empty');
    expect(call).toThrow('Set "endpoint" to the path of "resource".');
    documented(
      "Configuration.md",
      'the path of "resource" ("/mcp") must equal "endpoint" ("/other") or be empty',
      'Set "endpoint" to the path of "resource".',
    );
  });

  it("serves the document at the root path for an origin-only audience, and the challenge names that path", async () => {
    await withServer({ resourceAtRoot: true }, async (server) => {
      expect(server.audience).toBe(server.origin);
      const refused = await rawRequest(server, { body: LIST });
      const challenge = parseChallenge(refused.headers.get("www-authenticate"));
      expect(challenge.params["resource_metadata"]).toBe(`${server.origin}/.well-known/oauth-protected-resource`);
      const response = await socketFetch(challenge.params["resource_metadata"]!);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { resource: string }).resource).toBe(server.origin);
      expect(await status(server, await rig().token(server))).toBe(200);
    });
    documented(
      "Configuration.md",
      "You may use a resource without a path.",
      "the document is served at the root well-known path, and the challenge names that path",
    );
  });

  it.each(["/", "mcp", "/mcp/", "/mcp?x=1", "/mcp#frag"])("refuses the endpoint %s", (endpoint) => {
    expect(() => createFastMcpAuth({ client: client(), endpoint: endpoint as never })).toThrow(InvalidConfigurationError);
    documented("Configuration.md", "`endpoint` must be an absolute path such as `/mcp`, without a trailing slash, query or fragment. `/` and values like `mcp` or `/mcp/` throw.");
  });

  it("ignores X-Forwarded-Host and X-Forwarded-Proto when it publishes the resource", async () => {
    await withServer({}, async (server) => {
      const response = await socketFetch(`${server.origin}/.well-known/oauth-protected-resource/mcp`, {
        headers: { "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" },
      });
      expect(((await response.json()) as { resource: string }).resource).toBe(server.audience);
    });
    documented("Configuration.md", "FastMCP does not follow `X-Forwarded-Host` or `X-Forwarded-Proto` when it serves the document");
  });
});

describe("Configuration.md: metadata", () => {
  it("serves the default document with the authorization server of the tenant and the Bearer method only", async () => {
    await withServer({}, async (server) => {
      const document = await (await socketFetch(`${server.origin}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(document).toEqual({
        resource: server.audience,
        authorization_servers: [`https://${DOMAIN}/`],
        bearer_methods_supported: ["header"],
      });
    });
    documented(
      "Configuration.md",
      "| `authorizationServers` | `authorization_servers` | `[\"https://<domain>/\"]`, built from the tenant domain. |",
      'The document always contains `bearer_methods_supported` with the value `["header"]`.',
    );
  });

  it("publishes the options under the documented field names", async () => {
    await withServer(
      {
        auth: {
          authorizationServers: ["https://login.example.com/"],
          metadata: {
            scopesSupported: ["read:orders", "write:orders"],
            resourceName: "Orders",
            resourceDocumentation: "https://docs.example.com/orders",
          },
        },
      },
      async (server) => {
        const document = await (await socketFetch(`${server.origin}/.well-known/oauth-protected-resource/mcp`)).json();
        expect(document).toEqual({
          resource: server.audience,
          authorization_servers: ["https://login.example.com/"],
          scopes_supported: ["read:orders", "write:orders"],
          resource_name: "Orders",
          resource_documentation: "https://docs.example.com/orders",
          bearer_methods_supported: ["header"],
        });
      },
    );
    documented(
      "Configuration.md",
      "| `metadata.scopesSupported` | `scopes_supported` | Left out. |",
      "| `metadata.resourceName` | `resource_name` | Left out. |",
      "| `metadata.resourceDocumentation` | `resource_documentation` | Left out. |",
    );
  });

  it.each([
    ["the default endpoint", {}],
    ["an origin-only audience", { resourceAtRoot: true }],
    ["a custom endpoint", { endpoint: "/api/mcp" as const }],
  ])("names, in the challenge, a route that serves the document (%s)", async (_label, options) => {
    await withServer(options, async (server) => {
      const refused = await rawRequest(server, { body: LIST });
      const url = parseChallenge(refused.headers.get("www-authenticate")).params["resource_metadata"]!;
      const response = await socketFetch(url);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { resource: string }).resource).toBe(server.audience);
    });
    documented("Configuration.md", "The document and the `WWW-Authenticate` challenge are built from the same resource and endpoint, so the challenge always names a route that serves the document.");
  });
});

describe("Configuration.md: required scopes, realm and the error observer", () => {
  it("answers 403 with an insufficient_scope challenge that lists only the missing scopes", async () => {
    await withServer({ auth: { requiredScopes: ["mcp:access", "mcp:more"] } }, async (server) => {
      const response = await rawRequest(server, {
        body: LIST,
        headers: { authorization: `Bearer ${await rig().token(server, { scope: "mcp:access" })}` },
      });
      expect(response.status).toBe(403);
      const challenge = parseChallenge(response.headers.get("www-authenticate"));
      expect(challenge.params["error"]).toBe("insufficient_scope");
      expect(challenge.params["scope"]).toBe("mcp:more");
      const ok = await rawRequest(server, {
        body: LIST,
        headers: { authorization: `Bearer ${await rig().token(server, { scope: "mcp:access mcp:more" })}` },
      });
      expect(ok.status).toBe(200);
    });
    documented(
      "Configuration.md",
      "A token that lacks one gets HTTP 403 before any tool runs.",
      "A token with all of them passes.",
      'The challenge has `error="insufficient_scope"` and a `scope` parameter that lists only the missing scopes.',
    );
  });

  it("puts the realm into the challenges and refuses a realm that cannot be written into one", async () => {
    await withServer({ auth: { realm: "orders" } }, async (server) => {
      const response = await rawRequest(server, { body: LIST });
      expect(response.headers.get("www-authenticate")).toMatch(/^Bearer realm="orders", /);
    });
    const client = createMcpClient({ domain: DOMAIN, audience: "https://mcp.example.com/mcp" });
    for (const realm of ['a"b', "", "   ", "a\\b", "a\nb"]) {
      expect(() => createFastMcpAuth({ client, realm }), JSON.stringify(realm)).toThrow(InvalidConfigurationError);
    }
    documented(
      "Configuration.md",
      'for example `Bearer realm="orders"`',
      "It must be a non-empty string without quotes, backslashes or control characters, or `createFastMcpAuth` throws `InvalidConfigurationError`.",
    );
  });

  it("hands the raw error to onError when authenticate answers 500, and ignores a hook that throws or rejects", async () => {
    const boom = new Error("raw secret detail");
    const failing = stubClient({
      verify: async () => {
        throw boom;
      },
    });
    const seen: unknown[] = [];
    const auth = createFastMcpAuth({ client: failing, onError: (error) => void seen.push(error) });
    const response = (await thrown(auth.authenticate(fakeRequest(bearer("x"))))) as Response;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
    expect(seen).toEqual([boom]);

    const throwing = createFastMcpAuth({
      client: failing,
      onError: () => {
        throw new Error("hook failed");
      },
    });
    expect(((await thrown(throwing.authenticate(fakeRequest(bearer("x"))))) as Response).status).toBe(500);

    const rejecting = createFastMcpAuth({ client: failing, onError: () => Promise.reject(new Error("hook rejected")) as never });
    expect(((await thrown(rejecting.authenticate(fakeRequest(bearer("x"))))) as Response).status).toBe(500);
    documented(
      "Configuration.md",
      "`onError` receives the raw error whenever `authenticate` answers 500. The error never reaches the response. The adapter ignores a hook that throws or returns a rejected promise.",
    );
  });
});

describe("Configuration.md: the table of all options", () => {
  it("lists every adapter option and every client option", () => {
    const adapterOptions: Record<keyof FastMcpAuthBaseOptions, true> = {
      resource: true,
      endpoint: true,
      authorizationServers: true,
      requiredScopes: true,
      realm: true,
      metadata: true,
      sessionBinding: true,
      onError: true,
    };
    const text = guideText("Configuration.md");
    const table = text.slice(text.indexOf("## All options"));
    for (const name of [...Object.keys(adapterOptions), "client", "domain", "audience", "clientId", "clientSecret", "tokenStore", "scopeMatching", "organizationPolicy", "organizationId", "requestTimeoutMs", "apiClient"]) {
      expect(table, name).toContain(`\`${name}\``);
    }
  });
});
