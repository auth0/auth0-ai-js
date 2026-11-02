import type { Principal, RequestScopedMcpClient } from "@auth0/ai-mcp";

/**
 * What `authenticate` returns and FastMCP hands to every tool as `context.session`.
 *
 * It is a `type` alias on purpose: FastMCP's session generic needs an index signature,
 * which an `interface` does not provide.
 *
 * The session holds no credential. `mcpClient` is the request-scoped client of
 * `@auth0/ai-mcp`; it closes over the verified token and never exposes it.
 */
export type Auth0Session = {
  /** The verified caller. */
  readonly principal: Principal;
  /**
   * The caller's scopes from the `scope` claim, as a top-level array so FastMCP's own
   * `requireScopes` and `canAccess` work on the session as they are.
   */
  readonly scopes: readonly string[];
  /** A client bound to this caller, for On Behalf Of exchanges and other token operations. */
  readonly mcpClient: RequestScopedMcpClient;
};

/** Narrows an unknown `context.session` to an {@link Auth0Session}. */
export function isAuth0Session(value: unknown): value is Auth0Session {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof Auth0Session, unknown>>;
  return (
    typeof candidate.principal === "object" &&
    candidate.principal !== null &&
    Array.isArray(candidate.scopes) &&
    typeof candidate.mcpClient === "object" &&
    candidate.mcpClient !== null
  );
}

/**
 * The server-level `onError` of the `createFastMcpAuth` call that created a session. The session is
 * frozen and its type is public, so the hook is kept next to it, keyed by the object itself: it is
 * invisible to `Object.keys`, spreads, JSON and the type, and a copy of the session loses it, which
 * only makes the tool fall back to the default log line.
 */
const errorHooks = new WeakMap<object, (error: unknown) => void>();

/** The server-level error hook that belongs to this session, if any. */
export function errorHookOf(session: Auth0Session): ((error: unknown) => void) | undefined {
  return errorHooks.get(session);
}

/** Builds the session for a verified caller. The result is frozen. */
export function createSession(
  principal: Principal,
  mcpClient: RequestScopedMcpClient,
  onError?: (error: unknown) => void,
): Auth0Session {
  const session = Object.freeze({
    principal,
    scopes: Object.freeze([...principal.scopes]),
    mcpClient,
  });
  if (typeof onError === "function") errorHooks.set(session, onError);
  return session;
}
