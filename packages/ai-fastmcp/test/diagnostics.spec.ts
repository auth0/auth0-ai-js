import { AuthError, DownscopedTokenError, InsufficientScopeError, UnauthenticatedError } from "@auth0/ai-mcp";
import { UserError } from "fastmcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFastMcpAuth } from "../src/create.js";
import { describeFailure } from "../src/log.js";
import { createSession } from "../src/session.js";
import type { Auth0Session } from "../src/session.js";
import { withAuth0Execute } from "../src/tool.js";
import type { ToolErrorResult } from "../src/tool.js";
import { bearer, callerFor, fakeRequest, principalOf, scopedClientOf, stubClient } from "./support/stubs.js";

const SECRET = "client-secret-s3cr3t";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

/** What the core library throws for a refused exchange: the Auth0 body sits two levels down. */
function exchangeFailure(body: Record<string, unknown> = {}): AuthError {
  const auth0Body = { error: "access_denied", error_description: "Unauthorized", ...body };
  const inner = new Error(`token request failed, Authorization: Basic ${SECRET}`, { cause: auth0Body });
  return Object.assign(new AuthError(`The token operation failed for ${TOKEN}`, "token_exchange_error", 403), {
    cause: inner,
  });
}

function sessionFor(onError?: (error: unknown) => void): Auth0Session {
  const principal = principalOf({ sub: "alice" });
  return createSession(principal, scopedClientOf(principal), onError);
}

async function run(execute: () => unknown, session: Auth0Session, options: Parameters<typeof withAuth0Execute>[1] = {}) {
  const wrapped = withAuth0Execute(async () => execute(), options);
  return (await wrapped({}, { session })) as ToolErrorResult;
}

describe("default log line for a failed tool", () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
  });

  it("writes exactly one line with the name, code, status and Auth0's error and description", async () => {
    const result = await run(() => Promise.reject(exchangeFailure()), sessionFor());
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line).toContain("AuthError");
    expect(line).toContain("code=token_exchange_error");
    expect(line).toContain("statusCode=403");
    expect(line).toContain("auth0_error=access_denied");
    expect(line).toContain('auth0_error_description="Unauthorized"');
    expect(line).not.toContain("\n");
    // The client still gets the fixed text and nothing from the error.
    expect(result.content[0]!.text).toBe("The token operation failed.");
    expect(JSON.stringify(result)).not.toContain("access_denied");
  });

  it("never carries the message, a token, a secret or an authorization header", async () => {
    await run(() => Promise.reject(exchangeFailure()), sessionFor());
    const line = String(error.mock.calls[0]![0]);
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("Authorization");
    expect(line).not.toContain("Basic");
    expect(line).not.toContain("token request failed");
  });

  it("logs a plain error with its name only", async () => {
    await run(() => Promise.reject(new TypeError("password is hunter2")), sessionFor());
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line).toContain("TypeError");
    expect(line).not.toContain("hunter2");
  });

  it("cuts the line at 300 characters and keeps it on one line", async () => {
    const long = `${"x".repeat(1000)}\nsecond line`;
    await run(() => Promise.reject(exchangeFailure({ error_description: long })), sessionFor());
    const line = String(error.mock.calls[0]![0]);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toContain("second line");
  });

  it("does not let an error forge a second log line", () => {
    const line = describeFailure(exchangeFailure({ error: "a\nFAKE LOG", error_description: "b\r\nFAKE2\u2028FAKE3" }));
    expect(line).not.toMatch(/[\r\n\u2028]/);
  });

  it("writes a quote in Auth0's description as an escaped character, so it cannot add a field", () => {
    const line = describeFailure(exchangeFailure({ error_description: 'bad" auth0_error=forged code=x' }));
    expect(line).toContain('auth0_error_description="bad\\" auth0_error=forged code=x"');
    // Read the line the way an operator's tooling would: key=value fields, quoted strings kept whole.
    const pattern = /\s*([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|\S+)/y;
    pattern.lastIndex = line.indexOf(" code=");
    const names: string[] = [];
    let end = pattern.lastIndex;
    for (let found = pattern.exec(line); found !== null; found = pattern.exec(line)) {
      names.push(found[1]!);
      end = pattern.lastIndex;
    }
    expect(end).toBe(line.length);
    expect(names).toEqual(["code", "statusCode", "auth0_error", "auth0_error_description"]);
  });

  it("quotes any value that is not a plain token, and leaves plain ones bare", () => {
    const line = describeFailure(exchangeFailure({ error: "two words code=9" }));
    expect(line).toContain('auth0_error="two words code=9"');
    expect(line).toContain("code=token_exchange_error");
    expect(describeFailure(exchangeFailure({ error: "invalid_grant" }))).toContain("auth0_error=invalid_grant ");
    const named = Object.assign(new Error("x"), { name: "Odd Name code=1" });
    expect(describeFailure(named)).toContain('Tool failed: "Odd Name code=1"');
  });

  it("starts with what failed", () => {
    expect(describeFailure(new Error("x"))).toBe("[ai-fastmcp] Tool failed: Error");
    expect(describeFailure(new Error("x"), "Authentication failed")).toBe("[ai-fastmcp] Authentication failed: Error");
  });

  it("survives a cause chain that loops", () => {
    const a: { cause?: unknown } = {};
    a.cause = { cause: a };
    expect(() => describeFailure(Object.assign(new Error("x"), { cause: a }))).not.toThrow();
  });

  it("does not use context.log, which FastMCP sends to the connected client", async () => {
    const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const wrapped = withAuth0Execute(async () => {
      throw exchangeFailure();
    });
    await wrapped({}, { session: sessionFor(), log } as { session: Auth0Session });
    expect(error).toHaveBeenCalledTimes(1);
    for (const method of Object.values(log)) expect(method).not.toHaveBeenCalled();
  });

  it("is silent when the per-tool onError is set, and calls it with the raw error", async () => {
    const raw = exchangeFailure();
    const onError = vi.fn();
    await run(() => Promise.reject(raw), sessionFor(), { onError });
    expect(onError).toHaveBeenCalledWith(raw);
    expect(error).not.toHaveBeenCalled();
  });

  it("is silent when the server-level onError is set, and calls it with the raw error", async () => {
    const raw = exchangeFailure();
    const onError = vi.fn();
    await run(() => Promise.reject(raw), sessionFor(onError));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(raw);
    expect(error).not.toHaveBeenCalled();
  });

  it("lets a per-tool onError override the server-level one", async () => {
    const raw = new Error("boom");
    const server = vi.fn();
    const tool = vi.fn();
    await run(() => Promise.reject(raw), sessionFor(server), { onError: tool });
    expect(tool).toHaveBeenCalledWith(raw);
    expect(server).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the result when the log call itself throws", async () => {
    error.mockImplementation(() => {
      throw new Error("stderr closed");
    });
    const result = await run(() => Promise.reject(new Error("x")), sessionFor());
    expect(result.content[0]!.text).toBe("Tool execution failed.");
  });

  it("does not log expected outcomes: scope denial, downscoped exchange, missing authentication, UserError", async () => {
    for (const thrownError of [new InsufficientScopeError(["a"]), new DownscopedTokenError(), new UnauthenticatedError()]) {
      await run(() => Promise.reject(thrownError), sessionFor());
    }
    await expect(run(() => Promise.reject(new UserError("shown")), sessionFor())).rejects.toBeInstanceOf(UserError);
    expect(error).not.toHaveBeenCalled();
  });

  it("does not log a successful call", async () => {
    await run(() => "fine", sessionFor());
    expect(error).not.toHaveBeenCalled();
  });
});

describe("server-level onError from createFastMcpAuth", () => {
  it("reaches the tool through the session that authenticate returns", async () => {
    const onError = vi.fn();
    const client = stubClient({ verify: async () => callerFor(principalOf({ sub: "alice" })) });
    const auth = createFastMcpAuth({ client, onError });
    const session = await auth.authenticate(fakeRequest(bearer("t")));
    const raw = exchangeFailure();
    const wrapped = withAuth0Execute(async () => {
      throw raw;
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await wrapped({}, { session });
      expect(onError).toHaveBeenCalledWith(raw);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not widen the session: same keys, frozen, no symbol, same JSON", async () => {
    const withHook = createFastMcpAuth({ client: stubClient(), onError: () => {} });
    const without = createFastMcpAuth({ client: stubClient() });
    const a = await withHook.authenticate(fakeRequest(bearer("t")));
    const b = await without.authenticate(fakeRequest(bearer("t")));
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(Object.getOwnPropertySymbols(a)).toEqual([]);
    expect(Object.isFrozen(a)).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("falls back to the log line for a session from a createFastMcpAuth without the hook", async () => {
    const hooked = vi.fn();
    createFastMcpAuth({ client: stubClient(), onError: hooked });
    const plain = createFastMcpAuth({ client: stubClient() });
    const session = await plain.authenticate(fakeRequest(bearer("t")));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run(() => Promise.reject(new Error("x")), session);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(hooked).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the hook for the 500 of authenticate", async () => {
    const onError = vi.fn();
    const boom = new Error("verify exploded");
    const auth = createFastMcpAuth({ client: stubClient({ verify: async () => Promise.reject(boom) }), onError });
    await expect(auth.authenticate(fakeRequest(bearer("t")))).rejects.toBeInstanceOf(Response);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});
