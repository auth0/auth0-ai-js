import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpResponse, delay, http } from "msw";
import { InvalidConfigurationError, createMcpClient } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import {
  DOMAIN,
  INITIALIZE_BODY,
  connect,
  callTool,
  createRig,
  parseChallenge,
  parseMessage,
  rawRequest,
  socketFetch,
  withServer,
} from "../integration/harness.js";
import { scopeMode } from "../support/index.js";
import { documented, loadSnippet } from "./guides.js";
import { startDocsServer, withEnv } from "./server.js";
import { installedFastmcpVersion, isBelowFloor } from "./versions.js";

/** Pins every claim of docs/Troubleshooting.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const GUIDE = "Troubleshooting.md";
const URL_AUDIENCE = "https://mcp.example.com/mcp";
const EMPTY_ENV = { AUTH0_DOMAIN: undefined, AUTH0_AUDIENCE: undefined, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: undefined };

describe("Troubleshooting.md: the server does not start", () => {
  const client = () => createMcpClient({ domain: DOMAIN, audience: URL_AUDIENCE });

  it("throws InvalidConfigurationError with the documented message for each mistake", async () => {
    await withEnv(EMPTY_ENV, () => {
      expect(() => createFastMcpAuth({})).toThrow(InvalidConfigurationError);
      expect(() => createFastMcpAuth({})).toThrow(
        'Missing MCP client option "domain": pass it explicitly or set the AUTH0_DOMAIN environment variable.',
      );
    });
    await withEnv({ ...EMPTY_ENV, AUTH0_DOMAIN: DOMAIN }, () => {
      expect(() => createFastMcpAuth({})).toThrow(
        'Missing MCP client option "audience": pass it explicitly or set the AUTH0_AUDIENCE environment variable.',
      );
    });
    const expectations: Array<[() => unknown, string, boolean]> = [
      [
        () => createFastMcpAuth({ client: client(), domain: DOMAIN } as never),
        'Invalid configuration: "client" cannot be combined with "domain". Pass either a client or client options.',
        true,
      ],
      [
        () => createFastMcpAuth({ client: client(), resource: "https://other.example.com/mcp" }),
        'Invalid configuration: "resource" must equal the client audience',
        true,
      ],
      [
        () => createFastMcpAuth({ client: client(), endpoint: "/other" }),
        'Invalid configuration: the path of "resource" ("/mcp") must equal "endpoint" ("/other") or be empty',
        true,
      ],
      [
        () => createFastMcpAuth({ client: client(), endpoint: "/mcp/" }),
        'Invalid configuration: "endpoint" must be a normalized absolute path such as "/mcp"',
        true,
      ],
      [
        () => createFastMcpAuth({ client: client(), realm: 'a"b' }),
        'Invalid configuration: "realm" must be a non-empty string without quotes, backslashes or control characters.',
        true,
      ],
      [
        () => createFastMcpAuth({ client: client(), sessionBinding: { maxSessions: 0 } }),
        'Invalid configuration: "sessionBinding.maxSessions" must be a positive number.',
        true,
      ],
      [
        () => createFastMcpAuth({ client: client(), sessionBinding: { ttlMs: -5 } }),
        'Invalid configuration: "sessionBinding.ttlMs" must be a positive number.',
        false,
      ],
      [
        () => createFastMcpAuth({ domain: DOMAIN, audience: URL_AUDIENCE, dpop: { mode: "required" } }),
        'Invalid configuration: DPoP mode "required" is not supported by the FastMCP adapter',
        true,
      ],
    ];
    for (const [call, message, quoted] of expectations) {
      expect(call).toThrow(InvalidConfigurationError);
      expect(call).toThrow(message);
      if (quoted) documented(GUIDE, message);
    }
    // The same messages exist for ttlMs and for the audience, as the guide says.
    documented(
      GUIDE,
      "The same message exists for `\"audience\"` and `AUTH0_AUDIENCE`.",
      "The same message exists for `ttlMs`.",
      "A trailing slash counts as a difference.",
    );
  });

  it("refuses an endpoint that is /, has no leading slash, ends in a slash, or has a query or fragment", () => {
    for (const endpoint of ["/", "mcp", "/mcp/", "/mcp?x=1", "/mcp#f"]) {
      expect(() => createFastMcpAuth({ client: client(), endpoint: endpoint as never }), endpoint).toThrow(
        'Invalid configuration: "endpoint" must be a normalized absolute path such as "/mcp"',
      );
    }
    documented(GUIDE, "The endpoint is `/`, has no leading slash, ends in a slash, or has a query or fragment.");
  });

  it("refuses an audience that is not an absolute http or https URL", () => {
    expect(() => createFastMcpAuth({ domain: DOMAIN, audience: "urn:acme:mcp" })).toThrow(InvalidConfigurationError);
    documented(GUIDE, "Setting the audience to an identifier that is not an absolute `http` or `https` URL, such as `urn:acme:mcp`, also throws.");
  });
});

describe("Troubleshooting.md: 401 and invalid_token with a token that looks fine", () => {
  it("answers each cause with the same text", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, organizationPolicy: "required" }),
    });
    try {
      const texts = new Set<string>();
      const base = { claims: { org_id: "org_1" } };
      const tokens = [
        await rig().token(server, { ...base, aud: "https://other.example.com/mcp" }),
        await rig().token(server, { ...base, iss: "https://evil.example.com/" }),
        await rig().token(server, { ...base, exp: Math.floor(Date.now() / 1000) - 100 }),
        await rig().token(server, { ...base, sub: false }),
        await rig().token(server), // no org_id
      ];
      for (const token of tokens) {
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(401);
        texts.add(((await response.json()) as { error_description: string }).error_description);
      }
      expect([...texts]).toEqual(["The access token is invalid or has expired."]);
      const valid = await rig().token(server, base);
      expect((await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${valid}` } })).status).toBe(200);
    } finally {
      await server.stop();
    }
    documented(
      GUIDE,
      "Every failed verification returns the same response, `The access token is invalid or has expired.`",
      "- **Audience.**",
      "- **Issuer.**",
      "- **Expiry.**",
      "- **Subject.**",
      "- **Organization.**",
    );
  });

  async function runVerificationScript(options: { aud?: string; iss?: string; exp?: number }) {
    const token = await rig().token({ audience: URL_AUDIENCE }, options);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = await withEnv({ ACCESS_TOKEN: token }, () =>
      loadSnippet(GUIDE, 1, {
        rewrites: [['"your-tenant.us.auth0.com"', JSON.stringify(DOMAIN)]],
        exportNames: [],
      }),
    );
    try {
      return { logged: log.mock.calls.flat().map(String), failed: error.mock.calls.flat().map(String) };
    } finally {
      loaded.dispose();
      log.mockRestore();
      error.mockRestore();
    }
  }

  it("names the failing check when the guide's script verifies the token", async () => {
    const valid = await runVerificationScript({});
    expect(valid.logged).toEqual(["The token is valid."]);
    expect(valid.failed).toEqual([]);

    const wrongAudience = await runVerificationScript({ aud: "https://other.example.com/mcp" });
    expect(wrongAudience.failed).toEqual(['unexpected "aud" claim value']);

    const wrongIssuer = await runVerificationScript({ iss: "https://evil.example.com/" });
    expect(wrongIssuer.failed[0]).toContain("iss");

    const expired = await runVerificationScript({ exp: Math.floor(Date.now() / 1000) - 100 });
    expect(expired.failed[0]).toContain("exp");
    documented(
      GUIDE,
      'For a token with the wrong audience the message reads `unexpected "aud" claim value`. The message for a wrong issuer names `iss`, and for an expired token it names `exp`.',
    );
  });

  it("answers a tenant that cannot be reached the same way", async () => {
    const server = await startDocsServer({ auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }) });
    try {
      rig().use(http.get(rig().tenant.auth0.jwksUri, () => HttpResponse.json({}, { status: 503 })));
      const response = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server)}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await server.stop();
    }
    documented(GUIDE, "The adapter reports a failure to fetch the discovery document or the keys the same way.");
  });
});

describe("Troubleshooting.md: the other symptoms", () => {
  it("shows 401 without an error value for a missing header or another scheme", async () => {
    await withServer({}, async (server) => {
      const cases: Array<Record<string, string>> = [{}, { authorization: "Basic YTpi" }];
      for (const headers of cases) {
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers });
        expect(response.status).toBe(401);
        expect(parseChallenge(response.headers.get("www-authenticate")).params["error"]).toBeUndefined();
        expect(((await response.json()) as { error_description: string }).error_description).toBe("Authentication is required.");
      }
    });
    documented(
      GUIDE,
      "The response has no `error` value in its challenge. The request had no `Authorization` header, or the header did not use the `Bearer` scheme.",
    );
  });

  it("names the DPoP texts and the malformed header", async () => {
    await withServer({}, async (server) => {
      const token = await rig().token(server);
      const dpop = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}`, dpop: "x" } });
      expect(((await dpop.json()) as { error_description: string }).error_description).toBe("DPoP is not supported by this server.");
      const malformed = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: "Bearer a b" } });
      expect(malformed.status).toBe(400);
      expect(((await malformed.json()) as { error_description: string }).error_description).toBe("The request is malformed.");
    });
    documented(
      GUIDE,
      "## 401 DPoP is not supported by this server.",
      "The text `DPoP-bound access tokens are not supported by this server.` means the token itself is bound to a key.",
      "## 400 The request is malformed.",
    );
  });

  it("lists the missing scopes in the challenge of a 403", async () => {
    await withServer({ auth: { requiredScopes: ["a:one", "b:two"] } }, async (server) => {
      const response = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server, { scope: "a:one" })}` },
      });
      expect(response.status).toBe(403);
      expect(parseChallenge(response.headers.get("www-authenticate")).params["scope"]).toBe("b:two");
    });
    documented(GUIDE, "The `scope` parameter of the challenge lists the missing ones.");
  });

  it("explains a Tool execution failed from a missing client secret, a refused exchange, and a downscoped grant", async () => {
    const errors: unknown[] = [];
    const missing = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => exchangeTool(s, errors),
    });
    const configured = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, clientId: "mcp-client", clientSecret: "secret" }),
      tools: (s) => exchangeTool(s, errors),
    });
    try {
      const first = await toolText(missing, await rig().token(missing));
      expect(first).toBe("Tool execution failed.");
      expect((errors.pop() as Error).constructor.name).toBe("MissingClientAuthError");

      rig().tenant.auth0.state.failure = { status: 400, body: { error: "unauthorized_client", error_description: "tenant says no" } };
      expect(await toolText(configured, await rig().token(configured))).toBe("Tool execution failed.");
      const refused = errors.pop() as Error & { cause?: unknown };
      expect(refused.constructor.name).toBe("TokenExchangeError");
      expect(refused.cause).toBeDefined();

      rig().tenant.auth0.state.failure = null;
      rig().tenant.auth0.state.scope = scopeMode.fixed("other:scope");
      expect(await toolText(configured, await rig().token(configured))).toBe("The token exchange did not grant the requested scopes.");
    } finally {
      await missing.stop();
      await configured.stop();
    }
    documented(
      GUIDE,
      "- A `MissingClientAuthError` means the exchange needs `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`",
      "- A `TokenExchangeError` means your tenant refused the exchange or the request failed. Its `cause` holds the tenant's answer.",
      "## The token exchange did not grant the requested scopes.",
    );
  });

  it("replaces an error that only looks like a UserError, which is what a second copy of fastmcp produces", async () => {
    // An error of another class with the same name stands in for a UserError of a second copy.
    class OtherCopyUserError extends Error {
      override name = "UserError";
    }
    const errors: unknown[] = [];
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => {
        s.addTool({
          name: "lookalike",
          parameters: z.object({}),
          execute: withAuth0Execute(
            async () => {
              throw new OtherCopyUserError("the order does not exist");
            },
            { onError: (error) => void errors.push(error) },
          ),
        });
      },
    });
    try {
      const response = await rawRequest(server, {
        body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lookalike", arguments: {} } },
        headers: { authorization: `Bearer ${await rig().token(server)}` },
      });
      const message = parseMessage(await response.text()) as { result: { content: Array<{ text: string }> } };
      expect(message.result.content[0]!.text).toBe("Tool execution failed.");
      expect(errors).toHaveLength(1);
    } finally {
      await server.stop();
    }
    documented(
      GUIDE,
      "## A UserError shows up as Tool execution failed.",
      "The wrapper recognizes a FastMCP `UserError` with `instanceof`, so it passes through only an error from the same copy of `fastmcp` that `@auth0/ai-fastmcp` uses.",
      "`fastmcp` is a peer dependency so that both sides share one copy.",
    );
  });

  it("answers 403 for a session that another subject used first", async () => {
    await withServer({ stateless: false }, async (server) => {
      const created = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server, { sub: "user|alice" })}` },
      });
      const id = created.headers.get("mcp-session-id")!;
      const as = async (sub: string) =>
        rawRequest(server, {
          body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
          headers: { authorization: `Bearer ${await rig().token(server, { sub })}`, "mcp-session-id": id, "mcp-protocol-version": "2025-06-18" },
        });
      expect((await as("user|alice")).status).toBe(200);
      const refused = await as("user|bob");
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error_description: string }).error_description).toBe("The session belongs to a different caller.");
    });
    documented(GUIDE, "## 403 The session belongs to a different caller.");
  });

  it("names a route that returns 404 when the endpoints differ", async () => {
    // The adapter is told /api/mcp, FastMCP serves /mcp.
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, endpoint: "/api/mcp" }),
      endpoint: "/api/mcp",
      serveEndpoint: "/mcp",
    });
    try {
      const refused = await rawRequest(server, { body: INITIALIZE_BODY });
      expect(refused.status).toBe(401);
      const url = parseChallenge(refused.headers.get("www-authenticate")).params["resource_metadata"]!;
      expect(url).toBe(`${server.origin}/.well-known/oauth-protected-resource/api/mcp`);
      expect((await socketFetch(url)).status).toBe(404);
      expect((await socketFetch(`${server.origin}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    } finally {
      await server.stop();
    }
    documented(GUIDE, "## The resource_metadata URL in a challenge returns 404", "The two endpoints differ. Pass the same value to both.");
  });

  it("ends a stalled discovery in 401 and a stalled exchange in Tool execution failed when requestTimeoutMs is set", async () => {
    const errors: unknown[] = [];
    const server = await startDocsServer({
      auth: (audience) =>
        createFastMcpAuth({ domain: DOMAIN, audience, clientId: "mcp-client", clientSecret: "secret", requestTimeoutMs: 300 }),
      tools: (s) => exchangeTool(s, errors),
    });
    try {
      // The exchange: verification works, the token endpoint never answers.
      rig().use(
        http.post(rig().tenant.auth0.tokenEndpoint, async () => {
          await delay("infinite");
          return HttpResponse.json({});
        }),
      );
      expect(await toolText(server, await rig().token(server))).toBe("Tool execution failed.");
    } finally {
      await server.stop();
    }
    const stalled = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, requestTimeoutMs: 300 }),
    });
    try {
      rig().use(
        http.get(rig().tenant.auth0.jwksUri, async () => {
          await delay("infinite");
          return HttpResponse.json({});
        }),
      );
      const response = await rawRequest(stalled, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(stalled)}` },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe("invalid_token");
    } finally {
      await stalled.stop();
    }
    documented(
      GUIDE,
      "A discovery or key request that exceeds it ends in a 401 `invalid_token`, and an exchange that exceeds it ends in `Tool execution failed.`.",
    );
  });
});

describe.runIf(isBelowFloor())("Troubleshooting.md: FastMCP below the floor", () => {
  it("rejects the _meta field of a tool error, as the guide describes", async () => {
    await withServer({}, async (server) => {
      const session = await connect(server, await rig().token(server, { scope: "x" }));
      try {
        const out = await callTool(session, "admin");
        expect(out.isError).toBe(true);
        expect(out.text.startsWith("Tool 'admin' execution failed:")).toBe(true);
        expect(out.text).toContain('Unrecognized key: \\"_meta\\"');
      } finally {
        await session.close();
      }
    });
    expect(installedFastmcpVersion()).toBeTruthy();
  });
});

describe("Troubleshooting.md: the _meta symptom", () => {
  it("is documented with the text a release below 4.7.0 produces", () => {
    documented(
      GUIDE,
      "## A tool result says Unrecognized key: \"_meta\"",
      "The text looks like `Tool 'admin' execution failed:` followed by a list that contains `Unrecognized key: \"_meta\"`.",
      "Install FastMCP 4.7.0 or later.",
    );
  });
});

function exchangeTool(s: { addTool(tool: never): void }, errors: unknown[]) {
  s.addTool({
    name: "exchange",
    parameters: z.object({}),
    execute: withAuth0Execute(
      async (_args: unknown, { session }: { session: { mcpClient: { getTokenOnBehalfOf(o: object): Promise<unknown> } } }) => {
        await session.mcpClient.getTokenOnBehalfOf({ audience: "https://api.example.com", scope: "api:read" });
        return "ok";
      },
      { onError: (error) => void errors.push(error) },
    ),
  } as never);
}

async function toolText(server: { url: URL }, token: string): Promise<string> {
  const response = await rawRequest(server, {
    body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "exchange", arguments: {} } },
    headers: { authorization: `Bearer ${token}` },
  });
  const message = parseMessage(await response.text()) as { result: { content: Array<{ text: string }> } };
  return message.result.content[0]!.text;
}
