import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { InvalidConfigurationError, getCallerMcpClientOrThrow } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import type { Auth0Session } from "../../src/index.js";
import { DOMAIN, DOWNSTREAM, callTool, connect, createRig, freePort, rawRequest, socketFetch, withServer } from "../integration/harness.js";
import { documented, loadSnippet } from "./guides.js";
import { fakeRequest, bearer, stubClient, thrown } from "../support/stubs.js";
import { startDocsServer, startGuideServer, withEnv } from "./server.js";

/**
 * Pins the claims about the failure line, the server-level onError, the endpoint, the trailing
 * slash rule, the path warning, the argument-less call and per-tool scope publication.
 */

const rig = createRig({ beforeAll, afterEach, afterAll });

const LINE =
  '[ai-fastmcp] Tool failed: TokenExchangeError code=token_exchange_error statusCode=403 auth0_error=access_denied auth0_error_description="Unauthorized"';

function exchangeTool(server: FastMCP<Auth0Session>, options?: Parameters<typeof withAuth0Execute>[1]): void {
  server.addTool({
    name: "invoices",
    parameters: z.object({}),
    execute: withAuth0Execute(async (_args, { session }) => {
      await session.mcpClient.getTokenOnBehalfOf({ audience: DOWNSTREAM, scope: "api:read" });
      return "unreachable";
    }, options),
  });
}

function refuseExchange(): void {
  rig().tenant.auth0.state.failure = { status: 403, body: { error: "access_denied", error_description: "Unauthorized" } };
}

describe("the default log line of a failed tool", () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
  });

  it("is written once for a refused exchange, exactly as the guides show it, and the client sees only the fixed text", async () => {
    await withServer({ tools: (server) => exchangeTool(server) }, async (server) => {
      refuseExchange();
      const session = await connect(server, await rig().token(server));
      try {
        const outcome = await callTool(session, "invoices");
        expect(outcome.text).toBe("Tool execution failed.");
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]![0])).toBe(LINE);
      } finally {
        await session.close();
      }
    });
    documented("Errors.md", LINE, "never holds the message of the error, a token, a secret, a header or a request body", "at most 300 characters");
    documented("Troubleshooting.md", LINE);
    documented("README.md", LINE);
  });

  it.each([
    [401, "access_denied", "Unauthorized", "a wrong client secret"],
    [400, "invalid_target", "Invalid audience specified.", "an audience the tenant does not know"],
  ] as const)("shows %i %s for %s, as Troubleshooting.md reads", async (status, code, description, what) => {
    await withServer({ tools: (server) => exchangeTool(server) }, async (server) => {
      rig().tenant.auth0.state.failure = { status, body: { error: code, error_description: description } };
      const session = await connect(server, await rig().token(server));
      try {
        await callTool(session, "invoices");
      } finally {
        await session.close();
      }
    });
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line, what).toContain(` statusCode=${status} auth0_error=${code} auth0_error_description="${description}"`);
    documented("Troubleshooting.md", `\`statusCode=${status} auth0_error=${code} auth0_error_description="${description}"\``);
  });

  it("is written by authenticate for an unexpected fault, starting with Authentication failed, and not for a failure the client caused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = stubClient({ verify: async () => Promise.reject(new TypeError("boom")) });
      const auth = createFastMcpAuth({ client });
      const response = (await thrown(auth.authenticate(fakeRequest(bearer("t"))))) as Response;
      expect(response.status).toBe(500);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toBe("[ai-fastmcp] Authentication failed: TypeError");
      expect(warn).not.toHaveBeenCalled();
      error.mockClear();
      expect(((await thrown(auth.authenticate(fakeRequest()))) as Response).status).toBe(401);
      expect(((await thrown(auth.authenticate(fakeRequest({ authorization: "Bearer abcĀ" })))) as Response).status).toBe(400);
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    documented(
      "Errors.md",
      "Without an `onError`, `authenticate` writes the same kind of line as for a failed tool",
      "starting `[ai-fastmcp] Authentication failed:`. Failures the client caused (400, 401, 403) are not logged.",
    );
  });

  it("is silent for authenticate when an onError is set, which receives the raw error instead", async () => {
    const onError = vi.fn();
    const boom = new TypeError("boom");
    const auth = createFastMcpAuth({ client: stubClient({ verify: async () => Promise.reject(boom) }), onError });
    expect(((await thrown(auth.authenticate(fakeRequest(bearer("t"))))) as Response).status).toBe(500);
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(error).not.toHaveBeenCalled();
  });

  it("does not go through context.log, which FastMCP sends to the connected client", () => {
    documented("Errors.md", "The wrapper does not use `context.log` for it, because FastMCP sends `context.log` to the connected client.");
  });

  it("is not written for a missing scope, which is an expected outcome", async () => {
    await withServer({}, async (server) => {
      const session = await connect(server, await rig().token(server, { scope: "read:orders" }));
      try {
        const outcome = await callTool(session, "admin");
        expect(outcome.text).toBe("Missing required scope: admin:all");
        expect(error).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    });
    documented("Errors.md", "The wrapper treats a missing scope, a downscoped exchange, a missing session and a `UserError` as expected outcomes and does not log them.");
  });

  it("puts Auth0's answer at error.cause.cause of the raw error that onError receives", async () => {
    const seen: unknown[] = [];
    await withServer({ auth: { onError: (e) => void seen.push(e) }, tools: (server) => exchangeTool(server) }, async (server) => {
      refuseExchange();
      const session = await connect(server, await rig().token(server));
      try {
        await callTool(session, "invoices");
      } finally {
        await session.close();
      }
    });
    expect(seen).toHaveLength(1);
    const body = ((seen[0] as Error).cause as Error).cause as { error: string; error_description: string };
    expect(body.error).toBe("access_denied");
    expect(body.error_description).toBe("Unauthorized");
    expect(error).not.toHaveBeenCalled();
    documented("Errors.md", "`error.cause` is the original error, and its `cause` holds the body of the answer", "reads `error.cause.cause`");
    documented("Troubleshooting.md", "whose own `cause` holds the body Auth0 returned (`error` and `error_description`)");
  });
});

describe("the onError of createFastMcpAuth", () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
  });

  it("is the default for a wrapped tool, is overridden by the hook of one tool, and replaces the log line", async () => {
    const serverLevel: unknown[] = [];
    const toolLevel: unknown[] = [];
    await withServer(
      {
        auth: { onError: (e) => void serverLevel.push(e) },
        tools: (server) => {
          exchangeTool(server);
          server.addTool({
            name: "own_hook",
            parameters: z.object({}),
            execute: withAuth0Execute(
              async () => {
                throw new Error("own");
              },
              { onError: (e) => void toolLevel.push(e) },
            ),
          });
        },
      },
      async (server) => {
        refuseExchange();
        const session = await connect(server, await rig().token(server));
        try {
          expect((await callTool(session, "invoices")).text).toBe("Tool execution failed.");
          expect((await callTool(session, "own_hook")).text).toBe("Tool execution failed.");
        } finally {
          await session.close();
        }
      },
    );
    expect(serverLevel).toHaveLength(1);
    expect(toolLevel).toHaveLength(1);
    expect((toolLevel[0] as Error).message).toBe("own");
    expect(error).not.toHaveBeenCalled();
    documented(
      "Configuration.md",
      "It is also the default for every tool wrapped with `withAuth0Execute`",
      "A hook passed to `withAuth0Execute` overrides this one for that tool.",
      "the default log line (see [Errors](./Errors.md#errors-inside-tools)) is not written, so the hook owns the reporting.",
      "The hook receives the raw error on the server only.",
    );
    documented("README.md", "Pass `onError` to `createFastMcpAuth` to handle the raw error of every wrapped tool, or to `withAuth0Execute` to override it for one tool.");
  });
});

describe("createFastMcpAuth with no argument", () => {
  it("reads the client from the environment, like an empty object", async () => {
    const env = {
      AUTH0_DOMAIN: DOMAIN,
      AUTH0_AUDIENCE: "https://env.example.com/mcp",
      AUTH0_CLIENT_ID: undefined,
      AUTH0_CLIENT_SECRET: undefined,
    };
    const [bare, empty] = await withEnv(env, () => [createFastMcpAuth(), createFastMcpAuth({})] as const);
    expect(bare.oauth.protectedResource).toEqual(empty.oauth.protectedResource);
    expect(bare.oauth.protectedResource.resource).toBe("https://env.example.com/mcp");
    documented("Configuration.md", "Call it with no argument (an empty object works the same)");
    documented("README.md", "`createFastMcpAuth()`, with no argument, reads");
    documented("GettingStarted.md", "Calling it with no argument means the settings come from the environment");
  });
});

describe("the endpoint", () => {
  it("defaults to the path of the audience, else /mcp, and is exposed as a read-only property that the spread leaves out", () => {
    const withPath = createFastMcpAuth({ domain: DOMAIN, audience: "https://mcp.example.com/api/mcp" });
    expect(withPath.endpoint).toBe("/api/mcp");
    expect(createFastMcpAuth({ domain: DOMAIN, audience: "https://mcp.example.com" }).endpoint).toBe("/mcp");
    expect(Object.keys(withPath)).toEqual(["authenticate", "oauth"]);
    expect("endpoint" in { ...withPath }).toBe(false);
    expect(() => {
      (withPath as { endpoint: string }).endpoint = "/other";
    }).toThrow(TypeError);
    expect(() => createFastMcpAuth({ domain: DOMAIN, audience: "https://mcp.example.com/api/mcp", endpoint: "/mcp" })).toThrow(
      /must equal "endpoint"/,
    );
    documented(
      "Configuration.md",
      "It defaults to the path of the audience when the audience has one (`/api/mcp` for `https://mcp.example.com/api/mcp`), and to `/mcp` when the audience is an origin only.",
      "a read-only property that is not enumerable, so `...auth` does not hand it to `new FastMCP`",
      "It must equal the path of the audience, and `createFastMcpAuth` throws when it does not.",
    );
    documented("GettingStarted.md", "It is not enumerable, so the spread does not hand it to FastMCP.");
    documented("README.md", "`auth.endpoint` is the path of the audience (`/mcp` here)");
  });

  it("serves the route and the metadata at the path of the audience when auth.endpoint goes to start, as the guides show", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const loaded = await withEnv(
      { AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: `${origin}/mcp`, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: undefined },
      () =>
        loadSnippet("GettingStarted.md", 1, {
          rewrites: [["port: 3000", `host: "127.0.0.1", port: ${port}`]],
          exportNames: ["server", "auth"],
        }),
    );
    try {
      expect((loaded.exports["auth"] as { endpoint: string }).endpoint).toBe("/mcp");
      const response = await socketFetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
      expect(response.status).toBe(200);
    } finally {
      await (loaded.exports["server"] as FastMCP<never>).stop();
      loaded.dispose();
    }
    documented("GettingStarted.md", "endpoint: auth.endpoint, port: 3000, stateless: true");
    documented("README.md", "httpStream: { endpoint: auth.endpoint, port: 3000, stateless: true }");
  });
});

describe("a trailing slash on the audience path", () => {
  it("is a startup error that names the fix, while an origin-only audience stays valid", () => {
    const attempt = () => createFastMcpAuth({ domain: DOMAIN, audience: "https://mcp.example.com/mcp/" });
    expect(attempt).toThrow(InvalidConfigurationError);
    expect(attempt).toThrow(
      'Invalid configuration: the resource "https://mcp.example.com/mcp/" ends with a slash, but FastMCP serves "/mcp" and not "/mcp/"',
    );
    expect(attempt).toThrow('Use the audience without the trailing slash ("https://mcp.example.com/mcp")');
    expect(() => createFastMcpAuth({ domain: DOMAIN, audience: "https://mcp.example.com/" })).not.toThrow();
    documented("Configuration.md", "FastMCP serves `/mcp` and not `/mcp/`, so the resource the metadata publishes would answer 404.");
    documented(
      "Configuration.md",
      "An audience whose path ends in a slash, such as `https://mcp.example.com/mcp/`, also throws `InvalidConfigurationError`.",
      "An audience that is an origin only, such as `https://mcp.example.com/`, stays valid.",
    );
    documented(
      "Troubleshooting.md",
      'Invalid configuration: the resource "https://mcp.example.com/mcp/" ends with a slash, but FastMCP serves "/mcp" and not "/mcp/"',
    );
    documented("README.md", "A path that ends in a slash, such as `https://host/mcp/`, throws `InvalidConfigurationError`.");
  });
});

describe("the warning for a request on another path", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("keeps the warning state per createFastMcpAuth call", async () => {
    const first = createFastMcpAuth({ client: stubClient() });
    const second = createFastMcpAuth({ client: stubClient() });
    for (const auth of [first, first, second, second]) {
      await thrown(auth.authenticate(fakeRequest({}, "/docs-per-instance")));
    }
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('"/docs-per-instance"'))).toHaveLength(2);
  });

  it("names the path and the configured endpoint once, reads no query string, and changes no response", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      endpoint: "/orders",
      serveEndpoint: "/docs-other",
    });
    try {
      const responses: Response[] = [];
      for (let i = 0; i < 3; i++) {
        responses.push(await rawRequest(server, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, path: "/docs-other?token=abc" }));
      }
      for (const response of responses) expect(response.status).toBe(401);
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[ai-fastmcp]"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('A request arrived on "/docs-other", but the configured endpoint is "/orders"');
      expect(lines[0]).not.toContain("abc");
      expect(lines[0]).not.toContain("token=");
    } finally {
      await server.stop();
    }
    documented(
      "Configuration.md",
      "the first request that reaches `authenticate` on the other path makes the adapter write one warning",
      "The warning appears once per path and per `createFastMcpAuth` call, shows the path only and never the query string, and changes no response.",
      "Requests for the endpoint and the well-known metadata routes do not trigger it.",
    );
    documented("Troubleshooting.md", '[ai-fastmcp] A request arrived on "/orders", but the configured endpoint is "/mcp"');
  });

  it("stays quiet when start and createFastMcpAuth agree", async () => {
    const server = await startDocsServer({ auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }), endpoint: "/agree-docs" });
    try {
      await rawRequest(server, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(warn.mock.calls.filter((call) => String(call[0]).startsWith("[ai-fastmcp]"))).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });
});

describe("a tool that is not wrapped", () => {
  it("fails the accessor with No authenticated request context although the request was authenticated", async () => {
    await withServer(
      {
        tools: (server) => {
          server.addTool({
            name: "bare",
            parameters: z.object({}),
            execute: async (_args, context) => {
              let accessor = "no error";
              try {
                getCallerMcpClientOrThrow();
              } catch (e) {
                accessor = (e as Error).message;
              }
              return JSON.stringify({ sub: context.session?.principal.sub ?? null, accessor });
            },
          });
        },
      },
      async (server) => {
        const session = await connect(server, await rig().token(server));
        try {
          const outcome = await callTool<{ sub: string; accessor: string }>(session, "bare");
          expect(outcome.value.sub).toBe("user|1");
          expect(outcome.value.accessor).toBe("No authenticated request context.");
        } finally {
          await session.close();
        }
      },
    );
    documented(
      "Troubleshooting.md",
      "The message does not mean the request lacked authentication: the request passed `authenticate` and `context.session` is set. Only the binding of the accessors is missing.",
    );
  });
});

describe("per-tool scopes", () => {
  const CHALLENGE = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  it("reach an OAuth client only through metadata.scopesSupported, as the guides show", async () => {
    const guide = await startGuideServer("GettingStarted.md", 2);
    try {
      const metadata = (await (await socketFetch(`${guide.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as {
        scopes_supported?: string[];
      };
      expect(metadata.scopes_supported).toEqual(["read:orders"]);
      const unauthenticated = await rawRequest(guide, { body: CHALLENGE });
      expect(unauthenticated.status).toBe(401);
      const without = await connect(guide, await rig().token(guide, { scope: "openid" }));
      try {
        const denied = await callTool(without, "list_orders");
        expect(denied.isError).toBe(true);
        expect(denied.text).toBe("Missing required scope: read:orders");
      } finally {
        await without.close();
      }
      const withScope = await connect(guide, await rig().token(guide, { scope: "read:orders" }));
      try {
        expect((await callTool(withScope, "list_orders")).text).toBe("No orders yet.");
      } finally {
        await withScope.close();
      }
    } finally {
      await guide.stop();
    }
    documented(
      "GettingStarted.md",
      "A tool can require a scope with `requiredScopes`. That scope reaches an OAuth client only through the metadata document or the challenge, and a scope that only one tool checks is not published automatically. List it in `metadata.scopesSupported`:",
      "The metadata document then lists `read:orders` as `scopes_supported`.",
      "every call to the tool answers `Missing required scope: read:orders`",
    );
  });

  it("are published when the Tools guide lists them in metadata.scopesSupported, and are not when it does not", async () => {
    const guide = await startGuideServer("Tools.md", 3);
    try {
      const metadata = (await (await socketFetch(`${guide.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as {
        scopes_supported?: string[];
      };
      expect(metadata.scopes_supported).toEqual(["write:orders", "refund:orders"]);
    } finally {
      await guide.stop();
    }
    const bare = await startGuideServer("Tools.md", 1);
    try {
      const metadata = (await (await socketFetch(`${bare.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("scopes_supported");
    } finally {
      await bare.stop();
    }
    documented(
      "Tools.md",
      "Per-tool scopes are not published automatically. An OAuth client asks only for the scopes it finds in the metadata document or in the challenge, so list them in `metadata.scopesSupported` as the snippet does.",
    );
    documented("README.md", "Per-tool scopes are not published automatically: list them in `metadata.scopesSupported`, or a client that reads the metadata asks for none.");
  });

  it("are published by the quickstart of the README", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const loaded = await withEnv(
      { AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: `${origin}/mcp`, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: undefined },
      () =>
        loadSnippet("README.md", 1, {
          rewrites: [["port: 3000", `host: "127.0.0.1", port: ${port}`]],
          exportNames: ["server"],
        }),
    );
    try {
      const metadata = (await (await socketFetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()) as {
        scopes_supported?: string[];
      };
      expect(metadata.scopes_supported).toEqual(["read:orders"]);
    } finally {
      await (loaded.exports["server"] as FastMCP<never>).stop();
      loaded.dispose();
    }
    documented(
      "README.md",
      "`metadata.scopesSupported` is how it reaches the client.",
      "Without it the client asks for no scope and every call to the tool answers `Missing required scope: read:orders`.",
    );
  });
});

describe("FastMCP and the trailing slash", () => {
  it("answers 404 on the route with a trailing slash, which is why the audience may not end in one", async () => {
    const server = await startDocsServer({ auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }) });
    try {
      const withSlash = await rawRequest(server, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, path: "/mcp/" });
      expect(withSlash.status).toBe(404);
      const without = await rawRequest(server, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(without.status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});
