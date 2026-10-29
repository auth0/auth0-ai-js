import { VerifyAccessTokenError } from "@auth0/auth0-api-js";
import { AuthError, InvalidConfigurationError } from "@auth0/ai-mcp";
import { describe, expect, it } from "vitest";
import { createFastMcpAuth } from "../src/create.js";
import type { FastMcpAuthOptions } from "../src/options.js";
import { createSession } from "../src/session.js";
import { withAuth0Execute } from "../src/tool.js";
import type { ToolErrorResult } from "../src/tool.js";
import { principalOf, scopedClientOf, stubClient } from "./support/stubs.js";

describe("error classes from @auth0/ai-mcp", () => {
  it("is the AuthError the core package throws, so a core error subclass is an instance of it", () => {
    expect(new VerifyAccessTokenError("rejected")).toBeInstanceOf(AuthError);
  });

  it("maps a core error that reaches a tool through the AuthError exported by @auth0/ai-mcp", async () => {
    const principal = principalOf({ sub: "alice", scopes: ["read:orders"] });
    const session = createSession(principal, scopedClientOf(principal));
    const wrapped = withAuth0Execute(async () => {
      throw new VerifyAccessTokenError("upstream detail that must not leak");
    });
    const result = (await wrapped({}, { session })) as ToolErrorResult;
    expect(result.content[0]!.text).toBe("The token operation failed.");
    expect(JSON.stringify(result)).not.toContain("upstream detail");
  });

  it("makes construction fail with the InvalidConfigurationError exported by @auth0/ai-mcp", () => {
    const attempt = () => createFastMcpAuth({ client: stubClient(), realm: "bad\nrealm" } as FastMcpAuthOptions);
    expect(attempt).toThrow(InvalidConfigurationError);
  });
});
