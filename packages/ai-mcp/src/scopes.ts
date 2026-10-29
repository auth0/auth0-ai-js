import { InvalidConfigurationError } from '@auth0/auth0-api-js';
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

/**
 * Validates and flattens a scope requirement. A requirement that names no scope would
 * pass for every caller, so it is a configuration mistake and is rejected.
 */
function normalize(required: string | readonly string[]): string[] {
  const list: unknown = typeof required === 'string' ? [required] : required;
  if (!Array.isArray(list) || list.length === 0) {
    throw new InvalidConfigurationError('Invalid scope requirement: name at least one scope.');
  }
  const scopes = list.flatMap((entry: unknown) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new InvalidConfigurationError('Invalid scope requirement: every scope must be a non-blank string.');
    }
    return entry.split(/\s+/).filter((scope) => scope.length > 0);
  });
  return scopes;
}

/**
 * Asserts that the principal holds every required scope (AND semantics). Only
 * the `scope` claim is consulted, never `permissions`.
 *
 * @param required - One scope, a space-delimited string of scopes, or a non-empty
 *   list of such strings.
 * @param principal - The principal to check. Passing `undefined` means use the
 *   current caller.
 * @throws {InsufficientScopeError} When any required scope is missing. The
 *   message is generic and does not list the scopes the caller holds.
 * @throws {InvalidConfigurationError} When `required` is an empty string, an empty
 *   list, or a list containing a blank or non-string entry.
 * @throws {UnauthenticatedError} When no principal is given and no request
 *   context is active.
 */
export function requireScopes(required: string | readonly string[], principal?: Principal): void {
  const needed = normalize(required);
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
 * @param required - One scope, a space-delimited string of scopes, or a non-empty
 *   list of such strings. Validated when the wrapper is created and copied then, so
 *   changing the list later has no effect.
 * @param handler - The tool handler to protect.
 * @returns A handler with the same arguments that resolves to the handler's
 *   result or to an error result.
 * @throws {InvalidConfigurationError} When `required` is an empty string, an empty
 *   list, or a list containing a blank or non-string entry.
 */
export function withRequiredScopes<A extends unknown[], R>(
  required: string | readonly string[],
  handler: (...args: A) => R | Promise<R>
): (...args: A) => Promise<R | McpToolErrorResult> {
  const needed = normalize(required);
  return async (...args: A) => {
    try {
      requireScopes(needed);
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
