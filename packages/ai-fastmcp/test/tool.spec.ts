import {
  AuthError,
  DownscopedTokenError,
  InsufficientScopeError,
  UnauthenticatedError,
  getCallerMcpClient,
  getCallerMcpClientOrThrow,
  getCallerPrincipal,
  requireScopes,
} from "@auth0/ai-mcp";
import { UserError } from "fastmcp";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/session.js";
import type { Auth0Session } from "../src/session.js";
import { withAuth0Execute } from "../src/tool.js";
import type { ToolErrorResult } from "../src/tool.js";
import { principalOf, scopedClientOf } from "./support/stubs.js";

function sessionFor(sub: string, scopes: string[] = ["read:orders"]): Auth0Session {
  const principal = principalOf({ sub, scopes });
  return createSession(principal, scopedClientOf(principal));
}

function contextFor(session: Auth0Session | undefined) {
  return { session };
}

function asError(value: unknown): ToolErrorResult {
  const result = value as ToolErrorResult;
  expect(result.isError).toBe(true);
  return result;
}

describe("withAuth0Execute", () => {
  describe("request context", () => {
    it("makes the accessors work inside the body", async () => {
      const session = sessionFor("alice");
      const execute = withAuth0Execute(async () => ({
        principal: getCallerPrincipal(),
        client: getCallerMcpClient(),
        orThrow: getCallerMcpClientOrThrow(),
      }));
      const seen = (await execute({}, contextFor(session))) as {
        principal: unknown;
        client: unknown;
        orThrow: unknown;
      };
      expect(seen.principal).toBe(session.principal);
      expect(seen.client).toBe(session.mcpClient);
      expect(seen.orThrow).toBe(session.mcpClient);
    });

    it("leaves the accessors invisible without the wrapper", async () => {
      const session = sessionFor("alice");
      const plain = async (context: { session: Auth0Session | undefined }) =>
        context.session === undefined ? null : getCallerPrincipal();
      expect(await plain(contextFor(session))).toBeUndefined();
      expect(() => getCallerMcpClientOrThrow()).toThrow(UnauthenticatedError);
    });

    it("does not leave the context bound after the call", async () => {
      const execute = withAuth0Execute(async () => getCallerPrincipal()?.sub);
      expect(await execute({}, contextFor(sessionFor("alice")))).toBe("alice");
      expect(getCallerPrincipal()).toBeUndefined();
    });

    it("keeps concurrent callers apart", async () => {
      const subs = ["alice", "bob", "carol", "dave"];
      const execute = withAuth0Execute(async (delay: number) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return getCallerPrincipal()?.sub;
      });
      const results = await Promise.all(
        Array.from({ length: 40 }, (_unused, i) => {
          const sub = subs[i % subs.length]!;
          return execute(i % 7, contextFor(sessionFor(sub))).then((seen) => ({ sub, seen }));
        }),
      );
      expect(results.filter((r) => r.seen !== r.sub)).toEqual([]);
    });

    it("passes the arguments and the context through unchanged", async () => {
      const context = contextFor(sessionFor("alice"));
      const execute = vi.fn(async (args: { id: string }, ctx: typeof context) => `${args.id}:${ctx.session?.principal.sub}`);
      const wrapped = withAuth0Execute(execute);
      expect(await wrapped({ id: "o-1" }, context)).toBe("o-1:alice");
      expect(execute).toHaveBeenCalledWith({ id: "o-1" }, context);
    });

    it("returns the value of a synchronous body", async () => {
      const wrapped = withAuth0Execute<unknown, { session?: Auth0Session }, string>(() => "sync");
      expect(await wrapped({}, contextFor(sessionFor("alice")))).toBe("sync");
    });
  });

  describe("missing session", () => {
    it.each([[undefined], [null], [{}], [{ principal: {}, scopes: [] }], ["text"]])(
      "returns an authentication error for %j without running the body",
      async (session) => {
        const body = vi.fn(async () => "ran");
        const wrapped = withAuth0Execute(body);
        const result = asError(await wrapped({}, { session } as never));
        expect(result._meta.error).toBe("invalid_token");
        expect(result.content[0]!.text).toBe("Authentication is required.");
        expect(body).not.toHaveBeenCalled();
      },
    );
  });

  describe("required scopes", () => {
    it("runs the body when the caller holds every scope", async () => {
      const wrapped = withAuth0Execute(async () => "ok", { requiredScopes: ["read:orders", "write:orders"] });
      expect(await wrapped({}, contextFor(sessionFor("alice", ["write:orders", "read:orders"])))).toBe("ok");
    });

    it("names the missing scope and does not run the body", async () => {
      const body = vi.fn(async () => "ran");
      const wrapped = withAuth0Execute(body, { requiredScopes: "write:orders" });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content).toEqual([{ type: "text", text: "Missing required scope: write:orders" }]);
      expect(result._meta).toEqual({ error: "insufficient_scope" });
      expect(body).not.toHaveBeenCalled();
    });

    it("names only the scopes that are missing", async () => {
      const wrapped = withAuth0Execute(async () => "ok", { requiredScopes: ["read:orders", "a", "b"] });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("Missing required scopes: a, b");
    });

    it("splits space-delimited scope strings", async () => {
      const wrapped = withAuth0Execute(async () => "ok", { requiredScopes: "read:orders  a" });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("Missing required scope: a");
    });

    it("does not list the scopes the caller holds", async () => {
      const wrapped = withAuth0Execute(async () => "ok", { requiredScopes: "admin" });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice", ["secret:held"]))));
      expect(JSON.stringify(result)).not.toContain("secret:held");
    });

    it("treats an empty requirement as no requirement", async () => {
      const wrapped = withAuth0Execute(async () => "ok", { requiredScopes: [] });
      expect(await wrapped({}, contextFor(sessionFor("alice", [])))).toBe("ok");
    });

    it("keeps odd characters in a scope name out of the text", async () => {
      const wrapped = withAuth0Execute(async () => "ok", { requiredScopes: ["bad\u0000\u001b[31mscope"] });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("Missing required scope: bad[31mscope");
    });

    it("caps the length of a scope name", async () => {
      const wrapped = withAuth0Execute(async () => "ok", { requiredScopes: ["s".repeat(500)] });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe(`Missing required scope: ${"s".repeat(128)}`);
    });
  });

  describe("errors thrown by the body", () => {
    it("maps InsufficientScopeError from requireScopes to a result naming the missing scope", async () => {
      const wrapped = withAuth0Execute(async (_args: unknown, ctx) => {
        requireScopes(["read:orders", "write:orders"], ctx.session.principal);
        return "ok";
      });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("Missing required scope: write:orders");
      expect(result._meta.error).toBe("insufficient_scope");
    });

    it("names the required scopes when the error carries scopes the caller already holds", async () => {
      const wrapped = withAuth0Execute(async () => {
        throw new InsufficientScopeError(["read:orders"]);
      });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("Missing required scope: read:orders");
    });

    it("maps DownscopedTokenError to fixed text", async () => {
      const wrapped = withAuth0Execute(async () => {
        throw new DownscopedTokenError("granted api:read only");
      });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("The token exchange did not grant the requested scopes.");
      expect(result._meta.error).toBe("insufficient_scope");
      expect(JSON.stringify(result)).not.toContain("granted api:read");
    });

    it("maps UnauthenticatedError to fixed text", async () => {
      const wrapped = withAuth0Execute(async () => {
        throw new UnauthenticatedError("expired at 12:00");
      });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("Authentication is required.");
      expect(result._meta.error).toBe("invalid_token");
      expect(JSON.stringify(result)).not.toContain("12:00");
    });

    it("replaces the message of a core error and reports the raw error", async () => {
      const onError = vi.fn();
      const raw = new AuthError("upstream said: client secret abc rejected", "invalid_grant", 400);
      const wrapped = withAuth0Execute(
        async () => {
          throw raw;
        },
        { onError },
      );
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("The token operation failed.");
      expect(result._meta.error).toBe("server_error");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(onError).toHaveBeenCalledWith(raw);
    });

    it("replaces the message of any other error and reports the raw error", async () => {
      const onError = vi.fn();
      const raw = new Error("db password is hunter2");
      const wrapped = withAuth0Execute(
        async () => {
          throw raw;
        },
        { onError },
      );
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(result.content[0]!.text).toBe("Tool execution failed.");
      expect(JSON.stringify(result)).not.toContain("hunter2");
      expect(onError).toHaveBeenCalledWith(raw);
    });

    it("replaces a thrown string or null too", async () => {
      for (const value of ["secret text", null, undefined, 42]) {
        const wrapped = withAuth0Execute(async () => {
          throw value;
        });
        const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
        expect(result.content[0]!.text).toBe("Tool execution failed.");
      }
    });

    it("catches an error thrown synchronously by the body", async () => {
      const wrapped = withAuth0Execute((): string => {
        throw new Error("sync secret");
      });
      const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
      expect(JSON.stringify(result)).not.toContain("sync secret");
    });

    it("rethrows a FastMCP UserError for FastMCP to show", async () => {
      const error = new UserError("the order does not exist");
      const onError = vi.fn();
      const wrapped = withAuth0Execute(
        async () => {
          throw error;
        },
        { onError },
      );
      await expect(wrapped({}, contextFor(sessionFor("alice")))).rejects.toBe(error);
      expect(onError).not.toHaveBeenCalled();
    });

    it("does not report denials and authentication errors as faults", async () => {
      const onError = vi.fn();
      for (const error of [
        new InsufficientScopeError(["a"]),
        new DownscopedTokenError(),
        new UnauthenticatedError(),
      ]) {
        const wrapped = withAuth0Execute(
          async () => {
            throw error;
          },
          { onError },
        );
        await wrapped({}, contextFor(sessionFor("alice")));
      }
      expect(onError).not.toHaveBeenCalled();
    });

    it("keeps the result when the error hook throws or rejects", async () => {
      for (const onError of [
        () => {
          throw new Error("hook failed");
        },
        () => Promise.reject(new Error("hook failed")),
      ]) {
        const wrapped = withAuth0Execute(
          async () => {
            throw new Error("boom");
          },
          { onError },
        );
        const result = asError(await wrapped({}, contextFor(sessionFor("alice"))));
        expect(result.content[0]!.text).toBe("Tool execution failed.");
      }
    });

    it("lets a result the body returns pass through unchanged", async () => {
      const own = { content: [{ type: "text" as const, text: "mine" }], isError: true };
      const wrapped = withAuth0Execute(async () => own);
      expect(await wrapped({}, contextFor(sessionFor("alice")))).toBe(own);
    });
  });
});
