// Public entry point of @auth0/ai-mcp: error classes and the types describing the client surface.
export { UnauthenticatedError, InsufficientScopeError, DownscopedTokenError } from './errors.js';
export type {
  Principal,
  RequestContext,
  McpClientOptions,
  RequestScopedMcpClient,
  ScopeMatching,
  OrganizationPolicy,
  OnBehalfOfOptions,
  ClientCredentialsOptions,
  TokenForServiceOptions,
  ClientCredentialsTokenResult,
  ServiceTokenResult,
} from './types.js';
export { buildPrincipal } from './principal.js';
export { createMcpClient, ForeignCallerError } from './client.js';
export type { McpClient, VerifiedCaller } from './client.js';
export {
  runWithRequestContext,
  getRequestContext,
  getCallerPrincipal,
  getCallerMcpClient,
  getCallerMcpClientOrThrow,
} from './request-context.js';
export { requireScopes, withRequiredScopes } from './scopes.js';
export type { McpToolErrorResult } from './scopes.js';
export { MemoryIndexedTokenStore } from './stores/memory-indexed-store.js';
export type { MemoryIndexedTokenStoreOptions } from './stores/memory-indexed-store.js';
export { createEncryptedTokenStore } from './stores/encrypted-store.js';
export type { EncryptedTokenStoreOptions } from './stores/encrypted-store.js';
// Types a custom token store needs, re-exported so integrators do not have to depend on the core package directly.
export type { CachedToken, IndexedTokenStore, TokenIndexMember, TokenSet, TokenStore } from '@auth0/auth0-api-js';
