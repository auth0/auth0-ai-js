/**
 * Compile-time checks: `npm run type-check` (tsc --noEmit) covers this file. The assertions
 * below also run, but their value is that the file compiles.
 */
import { getCallerMcpClientOrThrow } from "@auth0/ai-mcp";
import { FastMCP, requireScopes } from "fastmcp";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "../src/index.js";
import type { Auth0Session, FastMcpAuth, FastMcpAuthOptions, ToolErrorResult } from "../src/index.js";
import { stubClient } from "./support/stubs.js";

describe("types", () => {
  const auth = createFastMcpAuth({ client: stubClient() });

  it("spreads into new FastMCP and fixes the session type", () => {
    const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });
    expectTypeOf(server).toEqualTypeOf<FastMCP<Auth0Session>>();
    expectTypeOf(auth).toEqualTypeOf<FastMcpAuth>();
    expect(server).toBeDefined();
  });

  it("keeps the argument and context types of the tool", () => {
    const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });
    server.addTool({
      name: "orders",
      description: "Orders.",
      parameters: z.object({ id: z.string(), limit: z.number().optional() }),
      execute: withAuth0Execute(async (args, ctx) => {
        expectTypeOf(args).toEqualTypeOf<{ id: string; limit?: number | undefined }>();
        expectTypeOf(ctx.session).toEqualTypeOf<Auth0Session>();
        const sub: string = ctx.session.principal.sub;
        return `${args.id}:${sub}`;
      }),
    });
    expect(server).toBeDefined();
  });

  it("gives the wrapped function a session that is not optional, without a non-null assertion", () => {
    const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });
    server.addTool({
      name: "who",
      parameters: z.object({}),
      execute: withAuth0Execute(async (_args, { session }) => {
        expectTypeOf(session).toEqualTypeOf<Auth0Session>();
        const sub: string = session.principal.sub;
        const scopes: readonly string[] = session.scopes;
        return `${sub}:${scopes.length}`;
      }),
    });
    expect(server).toBeDefined();
  });

  it("keeps the session optional in the context the outer function accepts", () => {
    const wrapped = withAuth0Execute<{ id: string }, { session?: Auth0Session }, Promise<number>>(async () => 42);
    expectTypeOf(wrapped).parameter(1).toEqualTypeOf<{ session?: Auth0Session }>();
    expect(wrapped).toBeDefined();
  });

  it("compiles the shapes the README shows", () => {
    const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });
    server.addTool({
      name: "list_orders",
      description: "Lists the caller's orders.",
      parameters: z.object({}),
      execute: withAuth0Execute(async (_args, { session }) => `Orders of ${session.principal.sub}`, {
        requiredScopes: "read:orders",
      }),
    });
    server.addTool({
      name: "invoices",
      parameters: z.object({ id: z.string() }),
      execute: withAuth0Execute(async ({ id }) => {
        const client = getCallerMcpClientOrThrow();
        return `${id}:${client.getPrincipal().sub}`;
      }),
    });
    expect(server).toBeDefined();
  });

  it("rejects misuse of the arguments and of the session", () => {
    const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });
    server.addTool({
      name: "misuse",
      parameters: z.object({ id: z.string() }),
      execute: withAuth0Execute(async (args, ctx) => {
        // @ts-expect-error id is a string, not a number
        const id: number = args.id;
        // @ts-expect-error the session has no such property
        const email: string = ctx.session.email;
        return `${id}${email}`;
      }),
    });
    expect(server).toBeDefined();
  });

  it("accepts FastMCP's requireScopes and the scope options", () => {
    const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });
    server.addTool({
      name: "gated",
      parameters: z.object({}),
      canAccess: requireScopes("admin"),
      execute: withAuth0Execute(async () => "ok", { requiredScopes: ["admin"] }),
    });
    expect(server).toBeDefined();
  });

  it("types the wrapped result as the body result or a tool error", () => {
    const wrapped = withAuth0Execute<{ id: string }, { session?: Auth0Session }, Promise<number>>(async () => 42);
    expectTypeOf(wrapped).returns.toEqualTypeOf<Promise<number | ToolErrorResult>>();
    expect(wrapped).toBeDefined();
  });

  it("offers the three client configuration tiers and nothing mixed", () => {
    const client = stubClient();
    const withClient: FastMcpAuthOptions = { client };
    const inline: FastMcpAuthOptions = { domain: "a.example.com", audience: "https://a.example.com/mcp" };
    const fromEnv: FastMcpAuthOptions = {};
    // @ts-expect-error client and inline client options cannot be combined
    const mixed: FastMcpAuthOptions = { client, domain: "a.example.com" };
    expect([withClient, inline, fromEnv, mixed]).toHaveLength(4);
  });

  it("exposes the session as a type alias FastMCP accepts", () => {
    expectTypeOf<Auth0Session>().toMatchTypeOf<Record<string, unknown>>();
  });
});
