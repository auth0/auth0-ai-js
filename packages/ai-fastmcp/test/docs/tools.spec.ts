import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpResponse, http } from "msw";
import { UnauthenticatedError, getCallerMcpClientOrThrow, getCallerPrincipal } from "@auth0/ai-mcp";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import type { Auth0Session } from "../../src/index.js";
import {
  DOMAIN,
  callTool,
  connect,
  createRig,
  parseMessage,
  rawRequest,
  withServer,
} from "../integration/harness.js";
import { createDownstreamOracle, exportJwks } from "../support/index.js";
import { documented } from "./guides.js";
import { startDocsServer, startGuideServer } from "./server.js";
import type { GuideServer } from "./server.js";

/** Pins every claim of docs/Tools.md. The blocks of the guide are run as written. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const TOOLS_CALL = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
});

async function toolResult(server: { url: URL }, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rawRequest(server, { body: TOOLS_CALL(name, args), headers: { authorization: `Bearer ${token}` } });
  const message = parseMessage(await response.text()) as {
    result?: { content: Array<{ text: string }>; isError?: boolean; _meta?: Record<string, unknown> };
    error?: { code: number; message: string };
  };
  return { status: response.status, ...message };
}

describe("Tools.md: the session", () => {
  it("describes the caller, as the guide's first block does", async () => {
    const guide: GuideServer = await startGuideServer("Tools.md", 1);
    try {
      const token = await rig().token(guide, { sub: "user|alice", claims: { azp: "client-a", org_id: "org_1" } });
      const out = await toolResult(guide, token, "who_am_i");
      expect(JSON.parse(out.result!.content[0]!.text)).toEqual({ sub: "user|alice", clientId: "client-a", orgId: "org_1" });
    } finally {
      await guide.stop();
    }
  });

  it("fills the principal from the claims named in the table", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 1800;
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => {
        s.addTool({
          name: "principal",
          parameters: z.object({}),
          execute: async (_args, { session }) =>
            JSON.stringify({
              principal: session?.principal,
              viaClient: session?.mcpClient.getPrincipal(),
              scopes: session?.scopes,
              frozenSession: Object.isFrozen(session),
              frozenScopes: Object.isFrozen(session?.scopes),
              methods: Object.keys(session?.mcpClient ?? {}).sort(),
              serialized: JSON.stringify(session),
            }),
        });
      },
    });
    try {
      const token = await rig().token(server, {
        sub: "user|p",
        scope: "read:orders write:orders",
        exp: expiry,
        claims: { azp: "from-azp", client_id: "from-client-id", org_id: "org_9", permissions: ["p:one"] },
      });
      const out = await toolResult(server, token, "principal");
      const body = JSON.parse(out.result!.content[0]!.text) as {
        principal: Record<string, unknown>;
        viaClient: Record<string, unknown>;
        scopes: string[];
        frozenSession: boolean;
        frozenScopes: boolean;
        methods: string[];
        serialized: string;
      };
      expect(body.principal).toEqual({
        sub: "user|p",
        expiresAt: expiry,
        scopes: ["read:orders", "write:orders"],
        permissions: ["p:one"],
        clientId: "from-azp",
        orgId: "org_9",
      });
      expect(body.viaClient).toEqual(body.principal);
      expect(body.scopes).toEqual(["read:orders", "write:orders"]);
      expect(body.frozenSession).toBe(true);
      expect(body.frozenScopes).toBe(true);
      expect(body.methods).toEqual(["getClientCredentialsToken", "getPrincipal", "getTokenForConnection", "getTokenOnBehalfOf"]);
      expect(body.serialized).not.toContain(token);
      expect(body.serialized).not.toContain(token.split(".")[2]!);

      // client_id is the fallback for azp; with neither claim the client is null; without org_id, null.
      const fallback = await toolResult(server, await rig().token(server, { claims: { azp: undefined, client_id: "only-client-id" } }), "principal");
      expect(JSON.parse(fallback.result!.content[0]!.text).principal).toMatchObject({ clientId: "only-client-id", orgId: null, permissions: null });
      const neither = await toolResult(server, await rig().token(server, { claims: { azp: undefined } }), "principal");
      expect(JSON.parse(neither.result!.content[0]!.text).principal.clientId).toBeNull();
    } finally {
      await server.stop();
    }
    documented(
      "Tools.md",
      "`clientId` the client that received the token (the `azp` claim, else `client_id`, else `null`), `orgId` the `org_id` claim or `null`, `permissions` the `permissions` claim or `null`, and `expiresAt` the expiry in epoch seconds.",
      "The session is frozen and holds no credential.",
      "| `scopes` | The same scopes as a plain, frozen array.",
      "The request-scoped client has four methods:",
      "| `getPrincipal()` | The verified caller, the same value as `session.principal`. |",
    );
  });

  it("takes scopes from the scope claim only: the permissions claim satisfies no scope check", async () => {
    await withServer({}, async (server) => {
      const session = await connect(server, await rig().token(server, { scope: "read:orders", claims: { permissions: ["admin:all"] } }));
      try {
        const denied = await callTool(session, "admin");
        expect(denied.isError).toBe(true);
        expect(denied.text).toBe("Missing required scope: admin:all");
      } finally {
        await session.close();
      }
    });
    documented("Tools.md", "no scope check uses it");
  });

  it("does not run a request without a valid token, so no tool sees an unauthenticated caller", async () => {
    let ran = 0;
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => {
        s.addTool({ name: "count", parameters: z.object({}), execute: withAuth0Execute(async () => String(++ran)) });
      },
    });
    try {
      const response = await rawRequest(server, { body: TOOLS_CALL("count") });
      expect(response.status).toBe(401);
      expect(ran).toBe(0);
    } finally {
      await server.stop();
    }
    documented("Tools.md", "A request without a valid token never reaches a tool");
  });

  it("answers Authentication is required, and does not run the function, when the wrapper finds no session", async () => {
    let ran = false;
    const wrapped = withAuth0Execute(async () => {
      ran = true;
      return "ran";
    });
    const result = await wrapped({}, {} as never);
    expect(result).toEqual({
      content: [{ type: "text", text: "Authentication is required." }],
      isError: true,
      _meta: { error: "invalid_token" },
    });
    expect(ran).toBe(false);
    documented("Tools.md", "when it finds no session, it returns the tool result `Authentication is required.` and does not run your function");
  });
});

describe("Tools.md: withAuth0Execute", () => {
  it("makes the accessors work inside the wrapper, as the guide's second block shows", async () => {
    const guide = await startGuideServer("Tools.md", 2);
    try {
      const out = await toolResult(guide, await rig().token(guide, { sub: "user|audit" }), "cancel_order", { id: "ord_7" });
      expect(out.result!.content[0]!.text).toBe("user|audit cancelled ord_7");
    } finally {
      await guide.stop();
    }
    documented("Tools.md", "`getCallerPrincipal()`, `getCallerMcpClient()` and `getCallerMcpClientOrThrow()`");
  });

  it("exchanges the caller's token through the accessor too, without the session argument", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience, clientId: "mcp-client", clientSecret: "secret" }),
      tools: (s) => {
        s.addTool({
          name: "exchange",
          parameters: z.object({}),
          execute: withAuth0Execute(async () => {
            const { accessToken } = await getCallerMcpClientOrThrow().getTokenOnBehalfOf({
              audience: "https://api.example.com",
              scope: "api:read",
            });
            return accessToken.length > 0 ? "exchanged" : "empty";
          }),
        });
      },
    });
    try {
      const out = await toolResult(server, await rig().token(server), "exchange");
      expect(out.result!.content[0]!.text).toBe("exchanged");
      expect(rig().tenant.auth0.state.successfulExchangeCount).toBe(1);
    } finally {
      await server.stop();
    }
    documented("Tools.md", "Inside any wrapped function, `getCallerMcpClientOrThrow().getTokenOnBehalfOf(...)` does the same without the session argument.");
  });

  it("leaves the accessors empty in a tool that is not wrapped, and getCallerMcpClientOrThrow throws UnauthenticatedError", async () => {
    await withServer({}, async (server) => {
      const session = await connect(server, await rig().token(server));
      try {
        const raw = await callTool<{ sessionSub: string; accessorSub: string | null; clientBound: boolean }>(session, "whoami_raw");
        expect(raw.value.sessionSub).toBe("user|1");
        expect(raw.value.accessorSub).toBeNull();
        expect(raw.value.clientBound).toBe(false);
      } finally {
        await session.close();
      }
    });
    expect(getCallerPrincipal()).toBeUndefined();
    expect(() => getCallerMcpClientOrThrow()).toThrow(UnauthenticatedError);
    expect(() => getCallerMcpClientOrThrow()).toThrow("No authenticated request context.");
    documented(
      "Tools.md",
      "A tool you do not wrap still gets `context.session`, but the accessors return `undefined` (`getCallerMcpClientOrThrow()` throws `UnauthenticatedError`).",
    );
  });
});

describe("Tools.md: resources and prompts", () => {
  it("hands the session to the load function of a resource and a prompt, and leaves the accessors empty", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => {
        const who = (auth?: Auth0Session) => JSON.stringify({ session: auth?.principal.sub ?? null, accessor: getCallerPrincipal()?.sub ?? null });
        s.addResource({ uri: "file:///who", name: "who", mimeType: "text/plain", load: async (auth) => ({ text: who(auth) }) });
        s.addPrompt({ name: "who", description: "Describes the caller.", load: async (_args, auth) => who(auth) });
      },
    });
    try {
      const session = await connect(server, await rig().token(server, { sub: "user|res" }));
      try {
        const resource = await session.client.readResource({ uri: "file:///who" });
        expect(JSON.parse((resource.contents[0] as { text: string }).text)).toEqual({ session: "user|res", accessor: null });
        const prompt = await session.client.getPrompt({ name: "who" });
        expect(JSON.parse((prompt.messages[0]!.content as { text: string }).text)).toEqual({ session: "user|res", accessor: null });
      } finally {
        await session.close();
      }
    } finally {
      await server.stop();
    }
    documented("Tools.md", "Resources and prompts receive the session as the `auth` argument of their `load` function, and the accessors return `undefined` there too.");
    documented("README.md", "Resources and prompts get the session as FastMCP passes it.");
  });
});

describe("Tools.md: scopes for one tool", () => {
  it("denies the caller that lacks a scope with a tool result, status 200, naming only the missing scopes", async () => {
    const guide = await startGuideServer("Tools.md", 3);
    try {
      const none = await toolResult(guide, await rig().token(guide, { scope: "read:orders" }), "refund_order", { id: "ord_1" });
      expect(none.status).toBe(200);
      expect(none.result).toEqual({
        content: [{ type: "text", text: "Missing required scopes: write:orders, refund:orders" }],
        isError: true,
        _meta: { error: "insufficient_scope" },
      });
      const one = await toolResult(guide, await rig().token(guide, { scope: "write:orders" }), "refund_order", { id: "ord_1" });
      expect(one.status).toBe(200);
      expect(one.result!.content[0]!.text).toBe("Missing required scope: refund:orders");
      expect(one.result!.isError).toBe(true);
      expect(one.result!._meta).toEqual({ error: "insufficient_scope" });
      const all = await toolResult(guide, await rig().token(guide, { scope: "write:orders refund:orders" }), "refund_order", { id: "ord_1" });
      expect(all.result!.content[0]!.text).toBe("Refunded ord_1");
      expect(all.result!.isError).toBeUndefined();
      // The tool stays in the list for a caller that lacks the scope.
      const list = await rawRequest(guide, {
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: { authorization: `Bearer ${await rig().token(guide, { scope: "read:orders" })}` },
      });
      expect(JSON.stringify(parseMessage(await list.text()))).toContain('"name":"refund_order"');
    } finally {
      await guide.stop();
    }
    documented(
      "Tools.md",
      "- The text is `Missing required scope: refund:orders` for one missing scope, or `Missing required scopes: write:orders, refund:orders` for several. It names only the scopes the caller lacks.",
      "- `isError` is `true` and `_meta.error` is `insufficient_scope`.",
      "- The HTTP status is 200. The tool stays in the tool list",
    );
  });

  it.each([
    ["one scope", "admin:all", "admin:all"],
    ["a space-delimited string", "a:one b:two", "a:one b:two"],
    ["an array", ["a:one", "b:two"], "a:one b:two"],
  ])("takes the requirement as %s and needs every scope", async (_label, requiredScopes, held) => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => {
        s.addTool({
          name: "gated",
          parameters: z.object({}),
          execute: withAuth0Execute(async () => "ran", { requiredScopes }),
        });
      },
    });
    try {
      const allowed = await toolResult(server, await rig().token(server, { scope: held }), "gated");
      expect(allowed.result!.content[0]!.text).toBe("ran");
      const first = held.split(" ")[0]!;
      const denied = await toolResult(server, await rig().token(server, { scope: first === held ? "other" : first }), "gated");
      expect(denied.result!.isError).toBe(true);
    } finally {
      await server.stop();
    }
    documented("Tools.md", "It takes one scope, a space-delimited string, or an array. The caller needs all of them.");
  });

  it("turns a failed requireScopes of @auth0/ai-mcp inside the function into the same result", async () => {
    await withServer({}, async (server) => {
      const session = await connect(server, await rig().token(server, { scope: "read:orders" }));
      try {
        const outcome = await callTool(session, "inner_scope");
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toBe("Missing required scope: write:orders");
        expect(outcome.meta).toEqual({ error: "insufficient_scope" });
      } finally {
        await session.close();
      }
    });
    documented("Tools.md", "`requireScopes` from `@auth0/ai-mcp` throws when the principal lacks a scope, and the wrapper turns that into the same result.");
  });

  it("hides a tool behind canAccess: absent from the list, Unknown tool on a direct call, available with the scope", async () => {
    const guide = await startGuideServer("Tools.md", 4);
    try {
      const plain = await rig().token(guide, { scope: "read:orders" });
      const list = await rawRequest(guide, {
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: { authorization: `Bearer ${plain}` },
      });
      expect(JSON.stringify(parseMessage(await list.text()))).not.toContain("purge_cache");
      const direct = await toolResult(guide, plain, "purge_cache");
      expect(direct.error?.message).toContain("Unknown tool");
      expect(JSON.stringify(parseMessage(await (await rawRequest(guide, {
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: { authorization: `Bearer ${plain}` },
      })).text()))).toContain("list_orders");
      expect([-32601, -32602]).toContain(direct.error?.code);

      const admin = await rig().token(guide, { scope: "admin:all" });
      const listed = await rawRequest(guide, {
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(JSON.stringify(parseMessage(await listed.text()))).toContain("purge_cache");
      expect((await toolResult(guide, admin, "purge_cache")).result!.content[0]!.text).toBe("purged");
    } finally {
      await guide.stop();
    }
    documented(
      "Tools.md",
      "It removes a tool with `canAccess: requireScopes(\"admin:all\")` from the tool list for callers without the scope, and a direct call to it fails with a JSON-RPC error whose message contains `Unknown tool`, provided the caller can see at least one other tool.",
    );
  });
});

describe("Tools.md: calling downstream APIs for the caller", () => {
  it("exchanges the caller's token and sends the downstream API the exchanged token, as the guide's last block does", async () => {
    const key = rig().tenant.key;
    const oracle = createDownstreamOracle({
      jwks: exportJwks(key),
      issuer: rig().tenant.auth0.issuer,
      audience: "https://api.example.com",
      requiredScope: "read:invoices",
    });
    rig().use(http.get("https://api.example.com/invoices/:id", async ({ request }) => {
      const verdict = await oracle.verifyAuthorization(request.headers.get("authorization"));
      return verdict.ok ? HttpResponse.text(`invoice for ${String(verdict.claims.sub)}`) : HttpResponse.text("refused", { status: verdict.status });
    }));
    const guide = await startGuideServer("Tools.md", 5);
    try {
      const callerToken = await rig().token(guide, { sub: "user|invoices", scope: "read:orders" });
      const out = await toolResult(guide, callerToken, "invoices", { id: "42" });
      expect(out.result!.content[0]!.text).toBe("invoice for user|invoices");
      const exchange = rig().tenant.auth0.state.lastExchangeRequest!;
      expect(exchange.params["audience"]).toBe("https://api.example.com");
      expect(exchange.params["scope"]).toBe("read:invoices");
      expect(exchange.params["subject_token"]).toBe(callerToken);
    } finally {
      await guide.stop();
    }
    documented(
      "Tools.md",
      "and never forward the access token it received",
      "const { accessToken } = await session!.mcpClient.getTokenOnBehalfOf({",
    );
  });

  it("fails the exchange with Tool execution failed, and hands the raw error to onError, when the client id and secret are missing", async () => {
    const errors: unknown[] = [];
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => {
        s.addTool({
          name: "exchange",
          parameters: z.object({}),
          execute: withAuth0Execute(
            async (_args, { session }) => {
              await session!.mcpClient.getTokenOnBehalfOf({ audience: "https://api.example.com" });
              return "ok";
            },
            { onError: (error) => void errors.push(error) },
          ),
        });
      },
    });
    try {
      const out = await toolResult(server, await rig().token(server), "exchange");
      // Verification worked without a client id and secret; only the exchange failed.
      expect(out.status).toBe(200);
      expect(out.result!.content[0]!.text).toBe("Tool execution failed.");
      expect(out.result!.isError).toBe(true);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).constructor.name).toBe("MissingClientAuthError");
    } finally {
      await server.stop();
    }
    documented(
      "Tools.md",
      "A server without them verifies tokens normally, but the exchange fails and the tool returns `Tool execution failed.`. The raw error reaches `onError`.",
    );
  });
});
