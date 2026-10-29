import { MemoryIndexedTokenStore } from "@auth0/ai-mcp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { scopeMode } from "../support/index.js";
import { callTool, connect, createRig, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

const MODES = [{ stateless: true }, { stateless: false }];

interface Delegated {
  status: number;
  sub: string;
  aud: string;
  scope: string;
}

describe.each(MODES)("on behalf of exchange through the session client (stateless: $stateless)", ({ stateless }) => {
  it("exchanges the caller's token and the downstream API accepts the result", async () => {
    await withServer({ stateless }, async (server) => {
      const session = await connect(server, await rig().token(server, { sub: "user|alice" }));
      try {
        const { isError, value } = await callTool<Delegated>(session, "delegate");
        expect(isError).toBe(false);
        expect(value).toEqual({ status: 200, sub: "user|alice", aud: "https://api.example.com", scope: "api:read" });
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        expect(rig().tenant.oracle.calls).toHaveLength(1);
        expect(rig().tenant.oracle.calls[0]!.verdict.ok).toBe(true);
      } finally {
        await session.close();
      }
    });
  });

  it("sends the caller's own token as the subject token and the server's client as the actor", async () => {
    await withServer({ stateless }, async (server) => {
      const token = await rig().token(server, { sub: "user|alice" });
      const session = await connect(server, token);
      try {
        await callTool(session, "delegate");
        const request = rig().tenant.auth0.state.lastExchangeRequest!;
        expect(request.params["subject_token"]).toBe(token);
        expect(request.params["audience"]).toBe("https://api.example.com");
        expect(request.clientId).toBe("mcp-client");
      } finally {
        await session.close();
      }
    });
  });

  it("exchanges on every call when no token store is configured", async () => {
    await withServer({ stateless }, async (server) => {
      const session = await connect(server, await rig().token(server));
      try {
        await callTool(session, "delegate");
        await callTool(session, "delegate");
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
      } finally {
        await session.close();
      }
    });
  });

  it("serves the second call from the cache when a MemoryIndexedTokenStore is configured", async () => {
    await withServer({ stateless, clientOptions: { tokenStore: new MemoryIndexedTokenStore() } }, async (server) => {
      const session = await connect(server, await rig().token(server));
      try {
        const first = await callTool<Delegated>(session, "delegate");
        const second = await callTool<Delegated>(session, "delegate");
        expect(first.value).toEqual(second.value);
        expect(second.value.status).toBe(200);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
      } finally {
        await session.close();
      }
    });
  });

  it("does not share cached tokens between callers", async () => {
    await withServer({ stateless, clientOptions: { tokenStore: new MemoryIndexedTokenStore() } }, async (server) => {
      const alice = await connect(server, await rig().token(server, { sub: "user|alice" }));
      const bob = await connect(server, await rig().token(server, { sub: "user|bob" }));
      try {
        const a = await callTool<Delegated>(alice, "delegate");
        const b = await callTool<Delegated>(bob, "delegate");
        expect([a.value.sub, b.value.sub]).toEqual(["user|alice", "user|bob"]);
        expect(rig().tenant.auth0.state.exchangeCount).toBe(2);
      } finally {
        await alice.close();
        await bob.close();
      }
    });
  });

  it("shares one exchange between concurrent calls of the same caller", async () => {
    await withServer({ stateless }, async (server) => {
      const session = await connect(server, await rig().token(server));
      try {
        const results = await Promise.all(Array.from({ length: 6 }, () => callTool<Delegated>(session, "delegate")));
        expect(results.every((r) => !r.isError && r.value.status === 200)).toBe(true);
        expect(rig().tenant.auth0.state.exchangeCount).toBeLessThan(6);
      } finally {
        await session.close();
      }
    });
  });

  describe("a failing exchange", () => {
    it("gives the client a generic tool error and nothing the authorization server said", async () => {
      await withServer({ stateless }, async (server) => {
        rig().tenant.auth0.state.failure = {
          status: 400,
          body: { error: "invalid_grant", error_description: "secret upstream detail: client_secret=hunter2" },
        };
        const session = await connect(server, await rig().token(server));
        try {
          const outcome = await callTool(session, "delegate");
          expect(outcome.isError).toBe(true);
          expect(outcome.text).toBe("Tool execution failed.");
          expect(outcome.meta).toEqual({ error: "server_error" });
          expect(outcome.text).not.toMatch(/secret|hunter2|invalid_grant/);
          // The error went to the observer, which is the only place it is visible.
          expect(server.errors).toHaveLength(1);
          expect((server.errors[0] as Error).message).toBe("The token operation failed.");
          expect(rig().tenant.auth0.state.exchangeCount).toBe(1);
        } finally {
          await session.close();
        }
      });
    });

    it("answers with HTTP 200, so the session survives and the next call can succeed", async () => {
      await withServer({ stateless }, async (server) => {
        rig().tenant.auth0.state.failure = { status: 500 };
        const session = await connect(server, await rig().token(server));
        try {
          expect((await callTool(session, "delegate")).isError).toBe(true);
          rig().tenant.auth0.state.failure = null;
          const recovered = await callTool<Delegated>(session, "delegate");
          expect(recovered.isError).toBe(false);
          expect(recovered.value.status).toBe(200);
          // Every POST succeeded. A stateless server answers the client's GET for a stream with 405.
          expect(session.seen.filter((entry) => entry.method === "POST").every((entry) => entry.status < 400)).toBe(true);
        } finally {
          await session.close();
        }
      });
    });

    it("does not cache a failure", async () => {
      await withServer({ stateless, clientOptions: { tokenStore: new MemoryIndexedTokenStore() } }, async (server) => {
        rig().tenant.auth0.state.failure = { status: 500 };
        const session = await connect(server, await rig().token(server));
        try {
          await callTool(session, "delegate");
          rig().tenant.auth0.state.failure = null;
          expect((await callTool(session, "delegate")).isError).toBe(false);
        } finally {
          await session.close();
        }
      });
    });
  });

  describe("an exchange that grants less than was requested", () => {
    it("is refused with fixed text and no scope data", async () => {
      await withServer({ stateless }, async (server) => {
        rig().tenant.auth0.state.scope = scopeMode.fixed("other:scope");
        const session = await connect(server, await rig().token(server));
        try {
          const outcome = await callTool(session, "delegate");
          expect(outcome.isError).toBe(true);
          expect(outcome.text).toBe("The token exchange did not grant the requested scopes.");
          expect(outcome.meta).toEqual({ error: "insufficient_scope" });
          expect(outcome.text).not.toContain("other:scope");
        } finally {
          await session.close();
        }
      });
    });
  });

  describe("errors inside a tool body", () => {
    it("replaces the message of an ordinary error, where FastMCP alone would copy it", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server));
        try {
          const wrapped = await callTool(session, "throws");
          expect(wrapped.isError).toBe(true);
          expect(wrapped.text).toBe("Tool execution failed.");
          const raw = await callTool(session, "throws_raw");
          expect(raw.isError).toBe(true);
          expect(raw.text).toContain("hunter2");
          expect(server.errors.map((e) => (e as Error).message)).toEqual(["db password is hunter2"]);
        } finally {
          await session.close();
        }
      });
    });

    it("lets a FastMCP UserError through, which is meant for the user", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server));
        try {
          const outcome = await callTool(session, "user_error");
          expect(outcome.isError).toBe(true);
          expect(outcome.text).toBe("the order does not exist");
          expect(server.errors).toEqual([]);
        } finally {
          await session.close();
        }
      });
    });
  });
});
