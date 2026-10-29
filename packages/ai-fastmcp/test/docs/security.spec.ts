import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { VerifyAccessTokenError } from "@auth0/auth0-api-js";
import { createFastMcpAuth, withAuth0Execute } from "../../src/index.js";
import {
  DOMAIN,
  INITIALIZE_BODY,
  callTool,
  connect,
  createRig,
  rawRequest,
  socketFetch,
  withServer,
} from "../integration/harness.js";
import { bearer, fakeRequest, stubClient, thrown } from "../support/stubs.js";
import { documented, packageDir } from "./guides.js";
import { startDocsServer } from "./server.js";

/** Pins every claim of docs/Security.md. */

const rig = createRig({ beforeAll, afterEach, afterAll });

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("Security.md: what the adapter enforces", () => {
  it("runs authenticate before any tool, and rejects a token issued for another API of the tenant", async () => {
    let ran = 0;
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
      tools: (s) => {
        s.addTool({ name: "count", parameters: z.object({}), execute: withAuth0Execute(async () => String(++ran)) });
      },
    });
    try {
      const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "count", arguments: {} } };
      expect((await rawRequest(server, { body: call })).status).toBe(401);
      const otherApi = await rig().token(server, { aud: "https://another-api.example.com" });
      expect((await rawRequest(server, { body: call, headers: { authorization: `Bearer ${otherApi}` } })).status).toBe(401);
      expect(ran).toBe(0);
      expect((await rawRequest(server, { body: call, headers: { authorization: `Bearer ${await rig().token(server)}` } })).status).toBe(200);
      expect(ran).toBe(1);
    } finally {
      await server.stop();
    }
    documented(
      "Security.md",
      "**Authentication comes first.**",
      "The adapter rejects a token issued for another API of your tenant, because it checks the audience.",
    );
  });

  it("holds no credential in the session: it is frozen and its serialization does not reveal the token", async () => {
    const server = await startDocsServer({
      auth: (audience) => createFastMcpAuth({ domain: DOMAIN, audience }),
    });
    try {
      const token = await rig().token(server);
      const session = await server.auth.authenticate({ headers: { authorization: `Bearer ${token}` } } as never);
      expect(Object.isFrozen(session)).toBe(true);
      expect(JSON.stringify(session)).not.toContain(token);
      expect(JSON.stringify(session)).not.toContain(token.split(".")[1]!);
    } finally {
      await server.stop();
    }
    documented("Security.md", "The access token is not a property of any of them, the session is frozen, and serializing it does not reveal the token.");
  });

  it("keeps the cause out of the response of a failed verification and of a fault", async () => {
    const verification = createFastMcpAuth({
      client: stubClient({
        verify: async () => {
          throw new VerifyAccessTokenError("kid k-123 not found in the key set");
        },
      }),
    });
    const refused = (await thrown(verification.authenticate(fakeRequest(bearer("x"))))) as Response;
    expect(await refused.text()).not.toContain("k-123");
    const fault = createFastMcpAuth({
      client: stubClient({
        verify: async () => {
          throw new Error("password=hunter2");
        },
      }),
    });
    const failed = (await thrown(fault.authenticate(fakeRequest(bearer("x"))))) as Response;
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("hunter2");
    documented("Security.md", "The error that the verifier or the client raised never reaches the response.");
  });

  it("replaces the message of an error thrown inside a wrapped tool", async () => {
    await withServer({}, async (server) => {
      const session = await connect(server, await rig().token(server));
      try {
        const wrapped = await callTool(session, "throws");
        expect(wrapped.text).toBe("Tool execution failed.");
        expect(wrapped.text).not.toContain("hunter2");
        const raw = await callTool(session, "throws_raw");
        expect(raw.text).toContain("hunter2");
      } finally {
        await session.close();
      }
    });
    documented("Security.md", "The wrapper replaces messages from inside a tool too");
  });

  it("answers a Bearer-only server: a DPoP header and a bound token get 401", async () => {
    await withServer({}, async (server) => {
      const token = await rig().token(server);
      expect((await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}`, dpop: "proof" } })).status).toBe(401);
      const bound = await rig().token(server, { claims: { cnf: { jkt: "t" } } });
      expect((await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${bound}` } })).status).toBe(401);
    });
    documented("Security.md", "A request with a `DPoP` header, and a token that claims a key binding, get a 401.");
  });

  it("reads the scope claim for both kinds of required scopes and exposes permissions without checking them", async () => {
    await withServer({ auth: { requiredScopes: ["mcp:access"] } }, async (server) => {
      const permissionsOnly = await rig().token(server, { scope: "other", claims: { permissions: ["mcp:access"] } });
      expect((await rawRequest(server, { body: LIST, headers: { authorization: `Bearer ${permissionsOnly}` } })).status).toBe(403);
      const noScopeClaim = await rig().token(server, { claims: { permissions: ["mcp:access"] } });
      expect((await rawRequest(server, { body: LIST, headers: { authorization: `Bearer ${noScopeClaim}` } })).status).toBe(403);
      const withScope = await rig().token(server, { scope: "mcp:access" });
      expect((await rawRequest(server, { body: LIST, headers: { authorization: `Bearer ${withScope}` } })).status).toBe(200);
    });
    documented("Security.md", "**Scopes come from the `scope` claim.**");
  });
});

describe("Security.md: what stays your job", () => {
  it("lets any valid token for the audience through when requiredScopes is not set", async () => {
    await withServer({}, async (server) => {
      const withoutScope = await rig().token(server, { scope: undefined });
      expect((await rawRequest(server, { body: LIST, headers: { authorization: `Bearer ${withoutScope}` } })).status).toBe(200);
    });
    documented("Security.md", "Without it, any valid token for the audience passes `authenticate`, and each tool decides for itself.");
  });
});

describe("Security.md: public routes, proxies, FastMCP's auth option and revocation", () => {
  it("serves /health, /ready and the metadata routes without a token", async () => {
    await withServer({}, async (server) => {
      for (const route of ["/health", "/ready", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const response = await socketFetch(`${server.origin}${route}`);
        expect(response.status, route).toBe(200);
      }
    });
    documented(
      "Security.md",
      "- `/health` and `/ready`.",
      "FastMCP serves some routes without authentication, and this adapter does not change that:",
    );
  });

  it("returns exactly the two options to spread, so FastMCP's auth option is never set", () => {
    const auth = createFastMcpAuth({ domain: DOMAIN, audience: "https://mcp.example.com/mcp" });
    expect(Object.keys(auth).sort()).toEqual(["authenticate", "oauth"]);
    documented("Security.md", "`createFastMcpAuth` returns exactly those two options for you to spread, and nothing else.");
  });

  it("describes FastMCP's auth option the way FastMCP's own types do", () => {
    const candidates = [
      path.join(packageDir, "node_modules", "fastmcp", "dist", "FastMCP.d.ts"),
      path.join(packageDir, "..", "..", "node_modules", "fastmcp", "dist", "FastMCP.d.ts"),
    ];
    const file = candidates.find((candidate) => {
      try {
        readFileSync(candidate);
        return true;
      } catch {
        return false;
      }
    });
    expect(file).toBeDefined();
    const types = readFileSync(file!, "utf8");
    expect(types).toContain("Authentication provider for OAuth flows.");
    expect(types).toMatch(/automatically configures the `authenticate` function\s+\*\s+and `oauth` settings/);
    documented("Security.md", "FastMCP documents it as a provider that configures `authenticate` and `oauth` itself");
  });

  it("makes no request to the tenant per request once the discovery document and the keys are fetched", async () => {
    await withServer({}, async (server) => {
      const token = await rig().token(server);
      const once = async () => rawRequest(server, { body: LIST, headers: { authorization: `Bearer ${token}` } });
      expect((await once()).status).toBe(200);
      const afterFirst = rig().requests.length;
      expect(afterFirst).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) expect((await once()).status).toBe(200);
      expect(rig().requests.length).toBe(afterFirst);
      for (const url of rig().requests) {
        expect(url).toMatch(/\.well-known\/openid-configuration$|jwks/);
      }
    });
    documented("Security.md", "After it has fetched the discovery document and the keys, it makes no call to the tenant per request.");
  });
});
