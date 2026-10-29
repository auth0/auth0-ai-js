import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callTool, connect, createRig, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

const MODES = [{ stateless: true }, { stateless: false }];

describe.each(MODES)("scope checks inside tools (stateless: $stateless)", ({ stateless }) => {
  describe("the requiredScopes option of withAuth0Execute", () => {
    it("answers a missing scope with a tool error that names it, at HTTP 200", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server, { scope: "read:orders" }));
        try {
          const outcome = await callTool(session, "admin");
          expect(outcome.isError).toBe(true);
          expect(outcome.text).toBe("Missing required scope: admin:all");
          expect(outcome.meta).toEqual({ error: "insufficient_scope" });
          expect(session.seen.filter((entry) => entry.method === "POST").every((entry) => entry.status < 300)).toBe(true);
          expect(server.errors).toEqual([]);
        } finally {
          await session.close();
        }
      });
    });

    it("runs the tool for a caller that holds the scope", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server, { scope: "read:orders admin:all" }));
        try {
          const outcome = await callTool(session, "admin");
          expect(outcome).toMatchObject({ isError: false, text: "admin ok" });
        } finally {
          await session.close();
        }
      });
    });

    it("keeps the connection usable after a denial", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server, { scope: "read:orders" }));
        try {
          expect((await callTool(session, "admin")).isError).toBe(true);
          expect((await callTool(session, "whoami")).isError).toBe(false);
        } finally {
          await session.close();
        }
      });
    });
  });

  describe("requireScopes inside the body", () => {
    it("is mapped to the same kind of tool error", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server, { scope: "read:orders" }));
        try {
          const denied = await callTool(session, "inner_scope");
          expect(denied).toMatchObject({ isError: true, text: "Missing required scope: write:orders" });
          expect(denied.meta).toEqual({ error: "insufficient_scope" });
        } finally {
          await session.close();
        }
        const allowed = await connect(server, await rig().token(server, { scope: "write:orders" }));
        try {
          expect(await callTool(allowed, "inner_scope")).toMatchObject({ isError: false, text: "write ok" });
        } finally {
          await allowed.close();
        }
      });
    });
  });

  describe("FastMCP canAccess, the alternative that hides the tool", () => {
    it("lists the tool only for a caller that holds the scope", async () => {
      await withServer({ stateless }, async (server) => {
        const plain = await connect(server, await rig().token(server, { scope: "read:orders" }));
        const admin = await connect(server, await rig().token(server, { scope: "read:orders admin:all" }));
        try {
          const plainNames = (await plain.client.listTools()).tools.map((tool) => tool.name);
          const adminNames = (await admin.client.listTools()).tools.map((tool) => tool.name);
          expect(plainNames).not.toContain("hidden");
          expect(adminNames).toContain("hidden");
          expect(plainNames).toContain("admin");
        } finally {
          await plain.close();
          await admin.close();
        }
      });
    });

    it("answers a direct call without the scope with a protocol error, not a scope error", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server, { scope: "read:orders" }));
        try {
          await expect(session.client.callTool({ name: "hidden", arguments: {} })).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining("Unknown tool"),
          });
        } finally {
          await session.close();
        }
      });
    });

    it("runs the tool for a caller that holds the scope", async () => {
      await withServer({ stateless }, async (server) => {
        const session = await connect(server, await rig().token(server, { scope: "admin:all" }));
        try {
          expect(await callTool(session, "hidden")).toMatchObject({ isError: false, text: "hidden ok" });
        } finally {
          await session.close();
        }
      });
    });
  });
});
