import { AsyncLocalStorage } from 'node:async_hooks';
import { UnauthenticatedError } from './errors.js';
import type { Principal, RequestContext, RequestScopedMcpClient } from './types.js';

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with `context` bound as the current request context. The context is
 * visible to everything `fn` starts, including code after `await`, timers and
 * promise chains, and is isolated from concurrent calls. Nested calls restore
 * the outer context when the inner one finishes.
 *
 * @param context - The context for the request being served.
 * @param fn - The work to run inside the context.
 * @returns Whatever `fn` returns.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Returns the current request context, or `undefined` when called outside
 * {@link runWithRequestContext}.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Returns the principal of the caller being served, or `undefined` when no
 * request context is active.
 */
export function getCallerPrincipal(): Principal | undefined {
  return storage.getStore()?.principal;
}

/**
 * Returns the client bound to the caller being served, or `undefined` when no
 * request context is active.
 */
export function getCallerMcpClient(): RequestScopedMcpClient | undefined {
  return storage.getStore()?.mcpClient;
}

/**
 * Returns the client bound to the caller being served.
 *
 * @throws {UnauthenticatedError} When no request context is active.
 */
export function getCallerMcpClientOrThrow(): RequestScopedMcpClient {
  const client = storage.getStore()?.mcpClient;
  if (!client) {
    throw new UnauthenticatedError('No authenticated request context.');
  }
  return client;
}
