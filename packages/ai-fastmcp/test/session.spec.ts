import { requireScopes } from "fastmcp";
import { describe, expect, it } from "vitest";
import { createSession, isAuth0Session } from "../src/session.js";
import { principalOf, scopedClientOf } from "./support/stubs.js";

describe("createSession", () => {
  it("exposes the principal, the scopes as an array and the client", () => {
    const principal = principalOf({ scopes: ["a", "b"] });
    const client = scopedClientOf(principal);
    const session = createSession(principal, client);
    expect(session.principal).toBe(principal);
    expect(session.mcpClient).toBe(client);
    expect(session.scopes).toEqual(["a", "b"]);
    expect(Array.isArray(session.scopes)).toBe(true);
  });

  it("copies the scopes so the principal and the session are independent", () => {
    const principal = principalOf({ scopes: ["a"] });
    const session = createSession(principal, scopedClientOf(principal));
    expect(session.scopes).not.toBe(principal.scopes);
  });

  it("is frozen, and so is its scope list", () => {
    const principal = principalOf();
    const session = createSession(principal, scopedClientOf(principal));
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.scopes)).toBe(true);
    expect(() => {
      (session.scopes as unknown as string[]).push("admin");
    }).toThrow(TypeError);
  });

  it("works with FastMCP's requireScopes check on a top-level array", () => {
    const principal = principalOf({ scopes: ["a", "b"] });
    const session = createSession(principal, scopedClientOf(principal));
    expect(requireScopes("a", "b")(session)).toBe(true);
    expect(requireScopes("a", "c")(session)).toBe(false);
  });
});

describe("isAuth0Session", () => {
  const principal = principalOf();
  const valid = createSession(principal, scopedClientOf(principal));

  it("accepts a session", () => {
    expect(isAuth0Session(valid)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "session"],
    ["an empty object", {}],
    ["no principal", { scopes: [], mcpClient: {} }],
    ["a null principal", { principal: null, scopes: [], mcpClient: {} }],
    ["no scopes", { principal: {}, mcpClient: {} }],
    ["scopes that are not an array", { principal: {}, scopes: "a b", mcpClient: {} }],
    ["no client", { principal: {}, scopes: [] }],
    ["a null client", { principal: {}, scopes: [], mcpClient: null }],
  ])("rejects %s", (_name, value) => {
    expect(isAuth0Session(value)).toBe(false);
  });
});
