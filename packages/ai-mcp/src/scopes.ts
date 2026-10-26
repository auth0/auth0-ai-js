import { InsufficientScopeError, UnauthenticatedError } from './errors.js';
import { getCallerPrincipal } from './request-context.js';
import type { Principal } from './types.js';

/**
 * A minimal MCP tool result that signals an error. Structurally compatible with
 * `CallToolResult` from the MCP SDK, defined here so the optional peer is not
 * needed at runtime.
 */
export interface McpToolErrorResult {
  /** Text content shown to the caller. Always generic. */
  content: Array<{ type: 'text'; text: string }>;
  /** Always `true`. */
  isError: true;
  /** Machine-readable marker for the failure kind. */
  _meta: { error: 'insufficient_scope' };
  [key: string]: unknown;
}

function normalize(required: string | readonly string[]): string[] {
  const list = typeof required === 'string' ? [required] : required;
  return list.flatMap((entry) => entry.split(/\s+/)).filter((entry) => entry.length > 0);
}

/**
 * Asserts that the principal holds every required scope (AND semantics). Only
 * the `scope` claim is consulted, never `permissions`.
 *
 * @param required - One scope, a space-delimited string of scopes, or a list.
 *   An empty requirement always passes.
 * @param principal - The principal to check. Passing `undefined` means use the
 *   current caller.
 * @throws {InsufficientScopeError} When any required scope is missing. The
 *   message is generic and does not list the scopes the caller holds.
 * @throws {UnauthenticatedError} When no principal is given and no request
 *   context is active.
 */
export function requireScopes(required: string | readonly string[], principal?: Principal): void {
  const needed = normalize(required);
  if (needed.length === 0) return;
  const caller = principal ?? getCallerPrincipal();
  if (!caller) {
    throw new UnauthenticatedError('No authenticated request context.');
  }
  const held = new Set(caller.scopes);
  if (!needed.every((scope) => held.has(scope))) {
    throw new InsufficientScopeError(needed);
  }
}

/**
 * Wraps a tool handler so it only runs when the current caller holds every
 * required scope. On a scope failure it returns a sanitized MCP error result
 * instead of throwing. Every other error, including those from the handler,
 * propagates unchanged.
 *
 * @param required - One scope, a space-delimited string of scopes, or a list.
 * @param handler - The tool handler to protect.
 * @returns A handler with the same arguments that resolves to the handler's
 *   result or to an error result.
 */
export function withRequiredScopes<A extends unknown[], R>(
  required: string | readonly string[],
  handler: (...args: A) => R | Promise<R>
): (...args: A) => Promise<R | McpToolErrorResult> {
  return async (...args: A) => {
    try {
      requireScopes(required);
    } catch (error) {
      if (error instanceof InsufficientScopeError) {
        return {
          content: [{ type: 'text', text: 'Missing one or more required scopes.' }],
          isError: true,
          _meta: { error: 'insufficient_scope' },
        };
      }
      throw error;
    }
    return handler(...args);
  };
}
