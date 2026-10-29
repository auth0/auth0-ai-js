import {
  BearerMethod,
  InvalidConfigurationError,
  ProtectedResourceMetadataBuilder,
} from "@auth0/auth0-api-js";
import { resolveResource } from "./authenticate.js";
import type { McpClient } from "./client.js";

/**
 * The issuer for a tenant domain, normalized the way the core client normalizes
 * it: the scheme is optional and must be https, the host is lower-cased, and no
 * path, query, fragment or credentials are allowed. Returns `undefined` for
 * anything else.
 */
function issuerFromDomain(domain: unknown): string | undefined {
  if (typeof domain !== "string") return undefined;
  const trimmed = domain.trim();
  if (trimmed === "" || /^http:\/\//i.test(trimmed)) return undefined;
  const withScheme = /^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    withScheme.includes("?") ||
    withScheme.includes("#") ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return undefined;
  }
  return `https://${url.host}/`;
}

/**
 * Returns the issuer URLs a server advertises as its authorization servers: the explicit list
 * unchanged, or `https://<domain>/` built from the client domain.
 *
 * @throws {InvalidConfigurationError} When no list is given and the client does not declare a
 * usable single tenant domain.
 */
export function resolveAuthorizationServers(client: McpClient, explicit: string[] | undefined): string[] {
  if (explicit !== undefined) return explicit;
  const issuer = issuerFromDomain(client.domain);
  if (issuer === undefined) {
    throw new InvalidConfigurationError(
      'Invalid configuration: "authorizationServers" is required because the client does not declare a single tenant domain. Set "authorizationServers" to the issuer URLs of your authorization servers.',
    );
  }
  return [issuer];
}

/** Input for {@link buildProtectedResourceMetadata}. */
export interface ProtectedResourceMetadataOptions {
  /**
   * The client. Its audience is the default `resource`, its domain the default authorization
   * server, and its DPoP mode decides the DPoP declarations in the document.
   */
  client: McpClient;
  /**
   * Identifier of the protected resource. Defaults to the client audience and, when set, must
   * equal it (see {@link authenticateRequest}).
   */
  resource?: string;
  /** Issuer URLs of the authorization servers. Defaults to `https://<domain>/`. */
  authorizationServers?: string[];
  /** Scopes to publish as `scopes_supported`. */
  scopesSupported?: string[];
  /** Human readable name to publish as `resource_name`. */
  resourceName?: string;
  /** Documentation URL to publish as `resource_documentation`. */
  resourceDocumentation?: string;
}

/** The RFC 9728 protected resource metadata document, as a plain JSON-serializable object. */
export type ProtectedResourceMetadataDocument = ReturnType<
  ReturnType<ProtectedResourceMetadataBuilder["build"]>["toJSON"]
>;

/**
 * Builds the RFC 9728 protected resource metadata document for an MCP server. Bearer is the
 * only bearer method; DPoP declarations follow `client.dpopMode`.
 *
 * Use it to serve the document from your own framework route. {@link createMcpHandler} serves
 * the same document itself.
 *
 * @param options - The client and the optional document fields.
 * @returns The document.
 * @throws {InvalidConfigurationError} When `resource` cannot be derived or differs from the
 * client audience, or `authorizationServers` cannot be derived.
 */
export function buildProtectedResourceMetadata(
  options: ProtectedResourceMetadataOptions,
): ProtectedResourceMetadataDocument {
  const resource = resolveResource(options.client, options.resource);
  const authorizationServers = resolveAuthorizationServers(options.client, options.authorizationServers);
  const dpop = options.client.dpopMode;
  const builder = new ProtectedResourceMetadataBuilder(resource, authorizationServers);
  builder.withBearerMethodsSupported([BearerMethod.HEADER]);
  if (dpop !== "disabled") builder.withDpopSigningAlgValuesSupported(["ES256"]);
  if (dpop === "required") builder.withDpopBoundAccessTokensRequired(true);
  if (options.scopesSupported !== undefined) builder.withScopesSupported(options.scopesSupported);
  if (options.resourceName !== undefined) builder.withResourceName(options.resourceName);
  if (options.resourceDocumentation !== undefined) {
    builder.withResourceDocumentation(options.resourceDocumentation);
  }
  return builder.build().toJSON();
}
