import {
  AuthError,
  DownscopedTokenError,
  InsufficientScopeError,
  UnauthenticatedError,
  runWithRequestContext,
} from "@auth0/ai-mcp";
import { UserError } from "fastmcp";
import { safely } from "./hooks.js";
import { normalizeRequiredScopes } from "./scopes.js";
import { describeFailure } from "./log.js";
import { errorHookOf, isAuth0Session } from "./session.js";
import type { Auth0Session } from "./session.js";

/**
 * A tool result that signals a failure. It is an ordinary MCP tool result with `isError: true`,
 * so the HTTP status stays 200 and the client reads the text. The text is fixed, or names only
 * scopes; it never carries the message of a caught error.
 */
export interface ToolErrorResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  _meta: { error: "insufficient_scope" | "invalid_token" | "server_error" };
  [key: string]: unknown;
}

/** Options of {@link withAuth0Execute}. */
export interface WithAuth0ExecuteOptions {
  /**
   * Scopes the caller must hold for this tool (all of them). Each entry is split on whitespace,
   * so `"read write"` means two scopes, and a blank entry throws `InvalidConfigurationError`
   * when the wrapper is created. A caller that lacks one gets a tool
   * error that names the missing scopes. The tool stays listed, unlike with FastMCP's `canAccess`,
   * which hides it and answers `Unknown tool`.
   */
  requiredScopes?: string | readonly string[];
  /**
   * Called with the raw error whenever a caught error is replaced by a generic result. It replaces
   * the `onError` given to `createFastMcpAuth` for this tool. The error never reaches the client,
   * and it can carry Auth0 response details, so the hook is the place to report it on the server.
   * Without a hook here or in `createFastMcpAuth`, one log line is written instead (see
   * {@link withAuth0Execute}). A throwing hook, or one that returns a rejected promise, is ignored.
   */
  onError?: (error: unknown) => void;
}

const MAX_SCOPE_LENGTH = 128;

function textResult(text: string, error: ToolErrorResult["_meta"]["error"]): ToolErrorResult {
  return { content: [{ type: "text", text }], isError: true, _meta: { error } };
}

/** Scope names come from the server's own code; this keeps odd characters and length out anyway. */
function printable(scope: string): string {
  return scope.replace(/[^\x21-\x7E]/g, "").slice(0, MAX_SCOPE_LENGTH);
}

function missingScopes(required: readonly string[], held: readonly string[]): string[] {
  const have = new Set(held);
  return required.filter((scope) => !have.has(scope));
}

function scopeDenied(missing: readonly string[]): ToolErrorResult {
  const names = missing.map(printable).filter((scope) => scope !== "");
  const text =
    names.length === 0
      ? "Missing a required scope."
      : names.length === 1
        ? `Missing required scope: ${names[0]}`
        : `Missing required scopes: ${names.join(", ")}`;
  return textResult(text, "insufficient_scope");
}

/**
 * Writes the default log line for a failure nobody asked to handle. It goes to the server's own
 * standard error stream and not to `context.log`, because FastMCP sends `context.log` to the
 * connected client as a logging notification, and this line can carry Auth0's error description.
 */
function reportFailure(error: unknown): void {
  try {
    console.error(describeFailure(error));
  } catch {
    // Logging must not change the result.
  }
}

/**
 * Turns an error thrown inside a tool into a result that is safe to show. FastMCP copies the
 * message of a thrown error into the result, so anything that is not meant for the client is
 * replaced here by fixed text. `UserError` is the one exception: FastMCP defines it as the error
 * whose message is meant for the user, so it is rethrown for FastMCP to handle.
 */
function toToolResult(error: unknown, session: Auth0Session, options: WithAuth0ExecuteOptions): ToolErrorResult {
  if (error instanceof UserError) throw error;
  if (error instanceof InsufficientScopeError) {
    const missing = missingScopes(error.requiredScopes, session.scopes);
    return scopeDenied(missing.length > 0 ? missing : error.requiredScopes);
  }
  if (error instanceof DownscopedTokenError) {
    return textResult("The token exchange did not grant the requested scopes.", "insufficient_scope");
  }
  if (error instanceof UnauthenticatedError) {
    return textResult("Authentication is required.", "invalid_token");
  }
  const hook = options.onError ?? errorHookOf(session);
  if (hook !== undefined) safely(hook, error);
  else reportFailure(error);
  if (error instanceof AuthError) {
    return textResult("The token operation failed.", "server_error");
  }
  return textResult("Tool execution failed.", "server_error");
}

/**
 * Wraps a tool's `execute` so the accessors of `@auth0/ai-mcp` (`getCallerMcpClient()`,
 * `getCallerPrincipal()` and the others) work inside the tool body.
 *
 * FastMCP gives a tool the caller through `context.session` and has no outer layer that could bind
 * an `AsyncLocalStorage` for the request, so the binding happens here, from the session
 * `authenticate` returned. Only `execute` is wrapped, so the argument types FastMCP infers from
 * `parameters` are kept.
 *
 * The wrapper also turns failures into safe tool results (see {@link ToolErrorResult}):
 * a missing scope names the scope, a failed token exchange or any other error becomes fixed text,
 * and nothing from the original message reaches the client. A FastMCP `UserError` passes through.
 *
 * When such an error is replaced and no `onError` is in effect (neither in `options` nor in
 * `createFastMcpAuth`), one line goes to the server's standard error stream: the error name, its
 * `code` and `statusCode`, and the `error` and `error_description` Auth0 returned when they are
 * found in the `cause` chain, cut to 300 characters. It never holds a token, a secret, a header or
 * a request body. A missing scope, a downscoped exchange and a missing session are expected
 * outcomes and are not logged.
 *
 * ```ts
 * server.addTool({
 *   name: "orders",
 *   parameters: z.object({ id: z.string() }),
 *   execute: withAuth0Execute(async ({ id }) => {
 *     const token = await getCallerMcpClientOrThrow().getTokenOnBehalfOf({ audience: "https://api.example.com" });
 *     // call the API with token.accessToken
 *   }, { requiredScopes: "read:orders" }),
 * });
 * ```
 *
 * The wrapped function receives a context whose `session` is always set: FastMCP types it as
 * optional, but the wrapper answers a call without a session itself and never runs the body then.
 *
 * @param execute - The tool's `execute`. Its context carries a non-optional `session`.
 * @param options - Per-tool scopes and an error observer.
 * @returns An `execute` with the same arguments.
 * @throws {InvalidConfigurationError} When `requiredScopes` has a blank or non-string entry.
 */
export function withAuth0Execute<A, C extends { session?: Auth0Session | undefined }, R>(
  execute: (args: A, context: C & { session: Auth0Session }) => R,
  options: WithAuth0ExecuteOptions = {},
): (args: A, context: C) => Promise<Awaited<R> | ToolErrorResult> {
  const needed = normalizeRequiredScopes(options.requiredScopes, "requiredScopes");
  return async (args, context): Promise<Awaited<R> | ToolErrorResult> => {
    const session: unknown = context.session;
    if (!isAuth0Session(session)) {
      return textResult("Authentication is required.", "invalid_token");
    }
    try {
      const missing = missingScopes(needed, session.scopes);
      if (missing.length > 0) return scopeDenied(missing);
      const value = await runWithRequestContext(
        { principal: session.principal, mcpClient: session.mcpClient },
        () => execute(args, context as C & { session: Auth0Session }),
      );
      return value as Awaited<R>;
    } catch (error) {
      return toToolResult(error, session, options);
    }
  };
}
