import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FastMCP, UserError } from "fastmcp";
import { HttpResponse, http } from "msw";
import { VerifyAccessTokenError } from "@auth0/auth0-api-js";
import { UnauthenticatedError } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import {
  DOMAIN,
  INITIALIZE_BODY,
  createRig,
  freePort,
  parseChallenge,
  parseMessage,
  rawRequest,
  withServer,
} from "../integration/harness.js";
import { scopeMode } from "../support/index.js";
import { bearer, fakeRequest, stubClient, thrown } from "../support/stubs.js";
import { documented } from "./guides.js";
import { startDocsServer, startGuideServer } from "./server.js";

/** Pins every claim of docs/Errors.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

interface Expected {
  status: number;
  error: string;
  description: string;
  challenge: boolean;
}

async function expectResponse(response: Response, expected: Expected) {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual({ error: expected.error, error_description: expected.description });
  const header = response.headers.get("www-authenticate");
  if (expected.challenge) {
    expect(header).not.toBeNull();
    expect(header!.startsWith("Bearer")).toBe(true);
    expect(header).toContain("resource_metadata=");
  } else {
    expect(header).toBeNull();
  }
}

describe("Errors.md: authentication failures", () => {
  it("answers each failure with the documented status, error, description and challenge", async () => {
    await withServer({ stateless: false }, async (server) => {
      const call = (headers: Record<string, string> = {}) => rawRequest(server, { body: INITIALIZE_BODY, headers });
      const valid = await rig().token(server);

      await expectResponse(await call({ authorization: "Bearer a b" }), {
        status: 400,
        error: "invalid_request",
        description: "The request is malformed.",
        challenge: true,
      });
      await expectResponse(await call({ authorization: `Bearer ${valid}`, "mcp-session-id": "x".repeat(257) }), {
        status: 400,
        error: "invalid_request",
        description: "The session id is not valid.",
        challenge: false,
      });
      await expectResponse(await call(), {
        status: 401,
        error: "unauthorized",
        description: "Authentication is required.",
        challenge: true,
      });
      await expectResponse(await call({ authorization: `Basic ${Buffer.from("a:b").toString("base64")}` }), {
        status: 401,
        error: "unauthorized",
        description: "Authentication is required.",
        challenge: true,
      });
      const invalid = {
        status: 401,
        error: "invalid_token",
        description: "The access token is invalid or has expired.",
        challenge: true,
      };
      await expectResponse(await call({ authorization: "Bearer abc.def.ghi" }), invalid);
      await expectResponse(await call({ authorization: `Bearer ${await rig().token(server, { aud: "https://other.example.com/mcp" })}` }), invalid);
      await expectResponse(await call({ authorization: `Bearer ${await rig().token(server, { iss: "https://evil.example.com/" })}` }), invalid);
      await expectResponse(await call({ authorization: `Bearer ${await rig().token(server, { exp: Math.floor(Date.now() / 1000) - 100 })}` }), invalid);
      await expectResponse(await call({ authorization: `Bearer ${await rig().token(server, { sub: false })}` }), invalid);
      await expectResponse(await call({ authorization: `Bearer ${valid}`, dpop: "x" }), {
        ...invalid,
        description: "DPoP is not supported by this server.",
      });
      await expectResponse(await call({ authorization: `Bearer ${await rig().token(server, { claims: { cnf: { jkt: "t" } } })}` }), {
        ...invalid,
        description: "DPoP-bound access tokens are not supported by this server.",
      });
    });
    documented(
      "Errors.md",
      "| 400 | `invalid_request` | `The request is malformed.` |",
      "| 400 | `invalid_request` | `The session id is not valid.` |",
      "| 401 | `unauthorized` | `Authentication is required.` |",
      "| 401 | `invalid_token` | `The access token is invalid or has expired.` |",
      "| 401 | `invalid_token` | `DPoP is not supported by this server.` |",
      "| 401 | `invalid_token` | `DPoP-bound access tokens are not supported by this server.` |",
      "Every body is JSON with an `error` and an `error_description`, and every response has `cache-control: no-store`.",
    );
  });

  it("treats an organization policy violation as a failed verification", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, organizationPolicy: "required" }),
    });
    try {
      const response = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server)}` },
      });
      await expectResponse(response, {
        status: 401,
        error: "invalid_token",
        description: "The access token is invalid or has expired.",
        challenge: true,
      });
    } finally {
      await server.stop();
    }
    documented("Errors.md", "wrong audience or issuer, no `sub`, or an organization policy violation");
  });

  it("answers a missing server-wide scope with 403 and lists only the missing scopes in the challenge", async () => {
    await withServer({ auth: { requiredScopes: ["a:one", "b:two"], realm: "orders" } }, async (server) => {
      const response = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server, { scope: "a:one" })}` },
      });
      await expectResponse(response, {
        status: 403,
        error: "insufficient_scope",
        description: "The access token does not include the required scope.",
        challenge: true,
      });
      const challenge = parseChallenge(response.headers.get("www-authenticate"));
      expect(challenge.params["scope"]).toBe("b:two");
      expect(challenge.params["realm"]).toBe("orders");
      expect(challenge.scheme).toBe("Bearer");
    });
    documented(
      "Errors.md",
      "| 403 | `insufficient_scope` | `The access token does not include the required scope.` |",
      "The 403 for a missing scope adds `scope=\"...\"`, which lists only the scopes the token lacks.",
      "A `realm` option adds `realm=\"...\"` to each challenge.",
    );
  });

  it("has no error value in the challenge of a missing credential, and the header reads Bearer resource_metadata", async () => {
    await withServer({}, async (server) => {
      const response = await rawRequest(server, { body: INITIALIZE_BODY });
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${server.origin}/.well-known/oauth-protected-resource/mcp"`,
      );
    });
    documented("Errors.md", "so the header reads `Bearer resource_metadata=\"...\"`");
  });

  it("answers a session mismatch with 403 forbidden and no challenge", async () => {
    await withServer({ stateless: false }, async (server) => {
      const created = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server, { sub: "user|alice" })}` },
      });
      const id = created.headers.get("mcp-session-id")!;
      const follow = (sub: string) =>
        rig()
          .token(server, { sub })
          .then((token) =>
            rawRequest(server, {
              body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
              headers: { authorization: `Bearer ${token}`, "mcp-session-id": id, "mcp-protocol-version": "2025-06-18" },
            }),
          );
      expect((await follow("user|alice")).status).toBe(200);
      await expectResponse(await follow("user|bob"), {
        status: 403,
        error: "forbidden",
        description: "The session belongs to a different caller.",
        challenge: false,
      });
    });
    documented("Errors.md", "| 403 | `forbidden` | `The session belongs to a different caller.` |");
  });

  it("answers an unexpected fault with 500 and a fixed body, with no challenge, and gives the raw error to onError", async () => {
    const seen: unknown[] = [];
    const fault = new Error("connection string with a password");
    const auth = createFastMcpAuth({
      client: stubClient({
        verify: async () => {
          throw fault;
        },
      }),
      onError: (error) => void seen.push(error),
    });
    const response = (await thrown(auth.authenticate(fakeRequest(bearer("x"))))) as Response;
    await expectResponse(response, {
      status: 500,
      error: "server_error",
      description: "Internal server error.",
      challenge: false,
    });
    expect(seen).toEqual([fault]);
    documented("Errors.md", "| 500 | `server_error` | `Internal server error.` |", "`onError` receives the raw error, so log it there.");
  });

  it("answers a failed verification with the same fixed text whatever the cause, and keeps the cause out of the response", async () => {
    const auth = createFastMcpAuth({
      client: stubClient({
        verify: async () => {
          throw new VerifyAccessTokenError("signature check failed for key k-123");
        },
      }),
    });
    const response = (await thrown(auth.authenticate(fakeRequest(bearer("x"))))) as Response;
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).not.toContain("k-123");
    expect(response.headers.get("www-authenticate")).not.toContain("k-123");
    documented("Errors.md", "A verification failure always gets the same text, whatever the cause");
  });

  it("reports a tenant that cannot be reached as a 401 invalid_token, without calling onError", async () => {
    const seen: unknown[] = [];
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, onError: (error) => void seen.push(error) }),
    });
    try {
      rig().use(
        http.get(rig().tenant.auth0.jwksUri, () => HttpResponse.json({ error: "down" }, { status: 503 })),
        http.get(`https://${DOMAIN}/.well-known/openid-configuration`, () => HttpResponse.json({ error: "down" }, { status: 503 })),
      );
      const response = await rawRequest(server, {
        body: INITIALIZE_BODY,
        headers: { authorization: `Bearer ${await rig().token(server)}` },
      });
      await expectResponse(response, {
        status: 401,
        error: "invalid_token",
        description: "The access token is invalid or has expired.",
        challenge: true,
      });
      expect(seen).toEqual([]);
    } finally {
      await server.stop();
    }
    documented(
      "Errors.md",
      "the core client reports it as a failed verification, so the caller gets the 401 `invalid_token` above and `onError` does not run",
    );
  });
});

describe("Errors.md: why authenticate throws only responses", () => {
  it("shows that FastMCP turns a thrown plain Error into a 401 that repeats the message", async () => {
    const port = await freePort();
    const bare = new FastMCP({
      name: "bare",
      version: "1.0.0",
      logger: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
      authenticate: async () => {
        throw new Error("secret detail");
      },
    });
    await bare.start({ transportType: "httpStream", httpStream: { port, host: "127.0.0.1", stateless: true } });
    try {
      const response = await rawRequest({ url: new URL(`http://127.0.0.1:${port}/mcp`) }, { body: INITIALIZE_BODY });
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("secret detail");
    } finally {
      await bare.stop();
    }
    documented("Errors.md", "It never throws anything else, because FastMCP would turn another error into a 401 that repeats its message.");
    documented("README.md", "FastMCP would turn a plain error into a 401 that echoes the message.");
  });
});

describe("Errors.md: errors inside tools", () => {
  async function toolServer(errors: unknown[]) {
    return startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, clientId: "mcp-client", clientSecret: "secret" }),
      tools: (s) => {
        const onError = (error: unknown) => void errors.push(error);
        const add = (name: string, execute: Parameters<typeof withAuth0Execute>[0], options = {}) =>
          s.addTool({ name, parameters: z.object({}), execute: withAuth0Execute(execute as never, { onError, ...options }) as never });
        add("scope_one", async () => "ran", { requiredScopes: "need:one" });
        add("scope_two", async () => "ran", { requiredScopes: ["need:one", "need:two"] });
        add("downscoped", async (_args: unknown, { session }: { session?: { mcpClient: { getTokenOnBehalfOf(o: object): Promise<unknown> } } }) => {
          await session!.mcpClient.getTokenOnBehalfOf({ audience: "https://api.example.com", scope: "api:read" });
          return "ran";
        });
        add("unauthenticated", async () => {
          throw new UnauthenticatedError();
        });
        add("auth_error", async () => {
          throw new VerifyAccessTokenError("detail of the failure");
        });
        add("other", async () => {
          throw new Error("db password is hunter2");
        });
        add("exchange", async (_args: unknown, { session }: { session?: { mcpClient: { getTokenOnBehalfOf(o: object): Promise<unknown> } } }) => {
          await session!.mcpClient.getTokenOnBehalfOf({ audience: "https://api.example.com", scope: "api:read" });
          return "ran";
        });
        add("user_error", async () => {
          throw new UserError("the order does not exist");
        });
        s.addTool({
          name: "unwrapped",
          parameters: z.object({}),
          execute: async () => {
            throw new Error("db password is hunter2");
          },
        });
      },
    });
  }

  async function call(server: { url: URL }, token: string, name: string) {
    const response = await rawRequest(server, {
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } },
      headers: { authorization: `Bearer ${token}` },
    });
    const message = parseMessage(await response.text()) as {
      result: { content: Array<{ text: string }>; isError?: boolean; _meta?: Record<string, unknown> };
    };
    return { status: response.status, text: message.result.content[0]!.text, isError: message.result.isError, meta: message.result._meta };
  }

  it("maps each kind of failure to its fixed text, error kind and status 200, and hands the raw error to onError only for the last two rows", async () => {
    const errors: unknown[] = [];
    const server = await toolServer(errors);
    try {
      const token = await rig().token(server, { scope: "need:none" });
      const expectFixed = async (name: string, text: string, kind: string, reported: number) => {
        errors.length = 0;
        const out = await call(server, token, name);
        expect(out, name).toEqual({ status: 200, text, isError: true, meta: { error: kind } });
        expect(errors, name).toHaveLength(reported);
      };
      await expectFixed("scope_one", "Missing required scope: need:one", "insufficient_scope", 0);
      await expectFixed("scope_two", "Missing required scopes: need:one, need:two", "insufficient_scope", 0);
      rig().tenant.auth0.state.scope = scopeMode.fixed("other:scope");
      await expectFixed("downscoped", "The token exchange did not grant the requested scopes.", "insufficient_scope", 0);
      rig().tenant.auth0.state.scope = scopeMode.echo;
      await expectFixed("unauthenticated", "Authentication is required.", "invalid_token", 0);
      await expectFixed("auth_error", "The token operation failed.", "server_error", 1);
      await expectFixed("other", "Tool execution failed.", "server_error", 1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toBe("db password is hunter2");

      // A refused exchange and an unreachable tenant both end as Tool execution failed.
      rig().tenant.auth0.state.failure = { status: 400, body: { error: "unauthorized_client", error_description: "nope" } };
      await expectFixed("exchange", "Tool execution failed.", "server_error", 1);
      rig().tenant.auth0.state.failure = null;
      rig().use(http.post(rig().tenant.auth0.tokenEndpoint, () => HttpResponse.error()));
      await expectFixed("exchange", "Tool execution failed.", "server_error", 1);
    } finally {
      await server.stop();
    }
    documented(
      "Errors.md",
      "| `Missing required scope: refund:orders` | `insufficient_scope` |",
      "Several missing scopes read `Missing required scopes: a, b`.",
      "| `The token exchange did not grant the requested scopes.` | `insufficient_scope` |",
      "| `Authentication is required.` | `invalid_token` |",
      "| `The token operation failed.` | `server_error` |",
      "| `Tool execution failed.` | `server_error` |",
      "All of these results have `isError: true` and the HTTP status 200.",
      "For every row except the first three, `withAuth0Execute` hands the raw error to its `onError` option",
    );
  });

  it("passes a FastMCP UserError through, and leaves a tool that is not wrapped to FastMCP, which repeats the message", async () => {
    const server = await toolServer([]);
    try {
      const token = await rig().token(server);
      const user = await call(server, token, "user_error");
      expect(user.text).toBe("the order does not exist");
      expect(user.isError).toBe(true);
      const raw = await call(server, token, "unwrapped");
      expect(raw.text).toContain("db password is hunter2");
    } finally {
      await server.stop();
    }
    documented(
      "Errors.md",
      "FastMCP copies the message of an error thrown by a tool into the tool result.",
      "a FastMCP `UserError`. FastMCP defines it as the error whose message is meant for the user, so the wrapper passes it through",
    );
  });

  it("ignores an onError hook that throws or rejects", async () => {
    const run = async (onError: (error: unknown) => unknown) => {
      const server = await startDocsServer({
        auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
        tools: (s) => {
          s.addTool({
            name: "boom",
            parameters: z.object({}),
            execute: withAuth0Execute(async () => {
              throw new Error("x");
            }, { onError: onError as never }),
          });
        },
      });
      try {
        return await call(server, await rig().token(server), "boom");
      } finally {
        await server.stop();
      }
    };
    const throwing = await run(() => {
      throw new Error("hook failed");
    });
    expect(throwing.text).toBe("Tool execution failed.");
    const rejecting = await run(() => Promise.reject(new Error("hook rejected")));
    expect(rejecting.text).toBe("Tool execution failed.");
    documented("Errors.md", "The hook runs on the server and the wrapper ignores its return value. The wrapper also ignores a hook that throws or returns a rejected promise.");
  });

  it("sanitizes errors of the request-scoped client: the message is replaced and the original error is the cause", async () => {
    const errors: unknown[] = [];
    const server = await toolServer(errors);
    try {
      rig().tenant.auth0.state.failure = { status: 400, body: { error: "unauthorized_client", error_description: "tenant detail" } };
      await call(server, await rig().token(server), "exchange");
      const error = errors[0] as Error & { cause?: unknown };
      expect(error.message).toBe("The token operation failed.");
      expect(error.cause).toBeDefined();
    } finally {
      await server.stop();
    }
    documented(
      "Errors.md",
      "it replaces the message with `The token operation failed.` and attaches the original error as `cause`. Do not send `cause` to a client.",
    );
  });

  it("runs the guide's onError block as written", async () => {
    const guide = await startGuideServer("Errors.md", 1);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const token = await rig().token(guide);
      const ok = await call(guide, token, "invoices");
      expect(ok.text).toBe("ok");
      rig().tenant.auth0.state.failure = { status: 400, body: { error: "unauthorized_client" } };
      const failed = await call(guide, token, "invoices");
      expect(failed.text).toBe("Tool execution failed.");
      expect(spy).toHaveBeenCalledWith("invoices failed", "TokenExchangeError");
    } finally {
      spy.mockRestore();
      await guide.stop();
    }
  });
});
