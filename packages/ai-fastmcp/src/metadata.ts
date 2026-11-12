import { buildProtectedResourceMetadata } from "@auth0/ai-mcp";
import type { McpClient } from "@auth0/ai-mcp";
import type { FastMcpAuthBaseOptions } from "./options.js";

/**
 * The `oauth.protectedResource` block FastMCP serves, with the keys FastMCP expects. FastMCP turns
 * camelCase keys into the snake_case keys of RFC 9728 when it serves the document, so the served
 * document equals the one `buildProtectedResourceMetadata` returned.
 */
export type FastMcpProtectedResource = {
  resource: string;
  authorizationServers: string[];
  [key: string]: unknown;
};

/** The `oauth` option of FastMCP, as far as this package fills it. */
export type FastMcpOAuthOptions = {
  enabled: true;
  protectedResource: FastMcpProtectedResource;
};

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * Builds the metadata document with `@auth0/ai-mcp` and renames its keys for FastMCP. The client
 * is the Bearer-only view, so the document never promises DPoP.
 */
export function buildProtectedResource(
  client: McpClient,
  options: Pick<FastMcpAuthBaseOptions, "resource" | "authorizationServers" | "metadata"> & {
    /** The normalized `requiredScopes`; published as `scopes_supported` unless `metadata.scopesSupported` is set. */
    requiredScopes?: readonly string[];
  },
): FastMcpProtectedResource {
  const document = buildProtectedResourceMetadata({
    client,
    resource: options.resource,
    authorizationServers: options.authorizationServers,
    // Without an explicit list, publish the scopes every request must carry, as the
    // `@auth0/ai-mcp` handler does, so a client that reads `scopes_supported` has something to ask for.
    scopesSupported:
      options.metadata?.scopesSupported ??
      (options.requiredScopes !== undefined && options.requiredScopes.length > 0
        ? [...options.requiredScopes]
        : undefined),
    resourceName: options.metadata?.resourceName,
    resourceDocumentation: options.metadata?.resourceDocumentation,
  });
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) renamed[snakeToCamel(key)] = value;
  return renamed as FastMcpProtectedResource;
}
