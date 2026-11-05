import { InvalidConfigurationError } from "@auth0/ai-mcp";
import { describe, expect, it } from "vitest";
import { normalizeRequiredScopes } from "../src/scopes.js";

describe("normalizeRequiredScopes", () => {
  it("means no requirement for undefined, null and an empty list", () => {
    expect(normalizeRequiredScopes(undefined, "requiredScopes")).toEqual([]);
    expect(normalizeRequiredScopes(null, "requiredScopes")).toEqual([]);
    expect(normalizeRequiredScopes([], "requiredScopes")).toEqual([]);
  });

  it("splits every entry on whitespace and drops repeats, keeping the first position", () => {
    expect(normalizeRequiredScopes(["read:orders  write:orders", "read:orders", "\tadmin\n"], "requiredScopes")).toEqual([
      "read:orders",
      "write:orders",
      "admin",
    ]);
  });

  it("accepts one string as one entry", () => {
    expect(normalizeRequiredScopes("read write", "requiredScopes")).toEqual(["read", "write"]);
  });

  it.each([[[""]], [["read", "   "]], [[1]], [[undefined]], [[null]], [[["read"]]], [[{}]]])(
    "rejects the blank or non-string entry %j",
    (list) => {
      expect(() => normalizeRequiredScopes(list, "requiredScopes")).toThrow(InvalidConfigurationError);
      expect(() => normalizeRequiredScopes(list, "requiredScopes")).toThrow(/every entry of "requiredScopes"/);
    },
  );

  it.each([[""], ["  "], [5], [{}], [true]])("rejects the value %j that is not a usable list", (value) => {
    expect(() => normalizeRequiredScopes(value, "requiredScopes")).toThrow(InvalidConfigurationError);
  });

  it("names the option in the message", () => {
    expect(() => normalizeRequiredScopes([""], "other")).toThrow(/"other"/);
  });

  it("returns a new array each call", () => {
    const input = ["a"];
    const out = normalizeRequiredScopes(input, "requiredScopes");
    expect(out).not.toBe(input);
    out.push("b");
    expect(input).toEqual(["a"]);
  });
});
