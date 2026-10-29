import { UnauthenticatedError } from '@auth0/ai-mcp';
import type {
  CachedToken,
  IndexedTokenStore,
  McpClientOptions,
  Principal,
  RequestContext,
  RequestScopedMcpClient,
  TokenSet,
  TokenStore,
} from '@auth0/ai-mcp';

const error: Error = new UnauthenticatedError();
export type Surface = [
  McpClientOptions,
  Principal,
  RequestContext,
  RequestScopedMcpClient,
  CachedToken,
  IndexedTokenStore,
  TokenSet,
  TokenStore,
];
export default error;
