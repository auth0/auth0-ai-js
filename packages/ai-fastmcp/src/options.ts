import { InvalidConfigurationError, createMcpClient, resolveMcpClientOptions } from "@auth0/ai-mcp";
import type { McpClient, McpClientOptions, McpHandlerClientConfig } from "@auth0/ai-mcp";
import type { SessionBindingOptions } from "./binding.js";

/** Options of {@link createFastMcpAuth} other than the client configuration. */
export interface FastMcpAuthBaseOptions {
  /**
   * Identifier of this MCP server: the absolute URL clients use to reach it, published as the
   * `resource` of the RFC 9728 metadata document. Defaults to the client audience when that is an
   * absolute `http` or `https` URL. When set, it must equal the client audience.
   *
   * Its path must be empty or equal `endpoint`, because FastMCP serves the metadata document at
   * the well-known path followed by `endpoint`, and the challenge has to point at that route.
   */
  resource?: string;
  /**
   * The path FastMCP serves the MCP route on. Pass the same value to
   * `server.start({ httpStream: { endpoint } })`.
   * @defaultValue `"/mcp"`
   */
  endpoint?: `/${string}`;
  /**
   * Issuer URLs of the authorization servers that can issue tokens for this server. Defaults to
   * `https://<domain>/`.
   */
  authorizationServers?: string[];
  /** Scopes every request must carry (all of them). A request without them is answered with 403. */
  requiredScopes?: readonly string[];
  /** Protection space reported as `realm` in challenges. */
  realm?: string;
  /** Fields of the RFC 9728 metadata document. */
  metadata?: {
    /** Scopes to publish as `scopes_supported`. */
    scopesSupported?: string[];
    /** Human readable name to publish as `resource_name`. */
    resourceName?: string;
    /** Documentation URL to publish as `resource_documentation`. */
    resourceDocumentation?: string;
  };
  /**
   * Binds each `mcp-session-id` to the subject that used it first and answers 403 to any other
   * subject on the same id. It applies only to requests that carry a session id, so stateless
   * servers are unaffected. Pass `false` to turn it off, or limits to tune it. The state is in
   * memory, per process.
   */
  sessionBinding?: false | SessionBindingOptions;
  /**
   * Called with the raw error whenever `authenticate` answers 500. The error never reaches the
   * response. A throwing hook, or one that returns a rejected promise, is ignored.
   */
  onError?: (error: unknown) => void;
}

/**
 * Options of {@link createFastMcpAuth}. Choose one of three ways to configure the client, the
 * same three as the `@auth0/ai-mcp` handler: pass `client`, pass inline client options (anything
 * you leave out of `domain`, `audience`, `clientId` and `clientSecret` is read from the
 * environment), or pass nothing and read all four from the environment. Passing `client` together
 * with an inline client option throws `InvalidConfigurationError`.
 */
export type FastMcpAuthOptions = McpHandlerClientConfig & FastMcpAuthBaseOptions;

const CLIENT_OPTION_NAMES = [
  "domain",
  "audience",
  "clientId",
  "clientSecret",
  "tokenStore",
  "scopeMatching",
  "organizationPolicy",
  "organizationId",
  "dpop",
  "requestTimeoutMs",
  "apiClient",
] as const satisfies ReadonlyArray<keyof McpClientOptions>;

// Fails to compile when McpClientOptions gains an option this list does not know about.
type UnlistedClientOption = Exclude<keyof McpClientOptions, (typeof CLIENT_OPTION_NAMES)[number]>;
const allClientOptionsListed: [UnlistedClientOption] extends [never] ? true : never = true;
void allClientOptionsListed;

/**
 * Splits the options into the client and everything else. The client is the given `client`, or
 * one built from the inline options and the environment.
 *
 * @throws {InvalidConfigurationError} When `client` is combined with inline client options, when
 * a required value is missing from both the options and the environment, or when the client
 * options are invalid.
 */
export function resolveClient(options: FastMcpAuthOptions): {
  client: McpClient;
  rest: FastMcpAuthBaseOptions;
} {
  const bag = options as Record<string, unknown>;
  const inline = CLIENT_OPTION_NAMES.filter((name) => bag[name] !== undefined);
  const rest: Record<string, unknown> = { ...bag };
  delete rest["client"];
  for (const name of CLIENT_OPTION_NAMES) delete rest[name];
  if (bag["client"] !== undefined) {
    if (inline.length > 0) {
      throw new InvalidConfigurationError(
        `Invalid configuration: "client" cannot be combined with ${inline.map((n) => `"${n}"`).join(", ")}. Pass either a client or client options.`,
      );
    }
    return { client: bag["client"] as McpClient, rest: rest as FastMcpAuthBaseOptions };
  }
  const explicit: Record<string, unknown> = {};
  for (const name of inline) explicit[name] = bag[name];
  return {
    client: createMcpClient(resolveMcpClientOptions(explicit as Partial<McpClientOptions>)),
    rest: rest as FastMcpAuthBaseOptions,
  };
}

/**
 * A view of the client that accepts and advertises Bearer only. The adapter does not verify DPoP
 * proofs, so `@auth0/ai-mcp` must neither accept the `DPoP` scheme nor list it in challenges or in
 * the metadata document. Verification still goes to the real client, which keeps its own DPoP mode
 * and refuses a DPoP-bound token presented as Bearer.
 *
 * @throws {InvalidConfigurationError} When the client requires DPoP, which this adapter cannot serve.
 */
export function bearerOnly(client: McpClient): McpClient {
  if (client.dpopMode === "required") {
    throw new InvalidConfigurationError(
      'Invalid configuration: DPoP mode "required" is not supported by the FastMCP adapter, which accepts Bearer tokens only. Use the default DPoP mode.',
    );
  }
  return Object.freeze({
    domain: client.domain,
    audience: client.audience,
    dpopMode: "disabled" as const,
    verifyAccessToken: (options: Parameters<McpClient["verifyAccessToken"]>[0]) => client.verifyAccessToken(options),
    withToken: (caller: Parameters<McpClient["withToken"]>[0]) => client.withToken(caller),
  });
}

const WELL_KNOWN_PRM = "/.well-known/oauth-protected-resource";

/**
 * Validates the endpoint.
 * @throws {InvalidConfigurationError} When it is not a normalized absolute path other than `/`.
 */
export function resolveEndpoint(endpoint: string | undefined): string {
  const value = endpoint ?? "/mcp";
  let normalized: string | undefined;
  if (value.startsWith("/")) {
    try {
      normalized = new URL(value, "http://localhost").pathname;
    } catch {
      normalized = undefined;
    }
  }
  if (normalized !== value || value === "/" || value.endsWith("/")) {
    throw new InvalidConfigurationError(
      'Invalid configuration: "endpoint" must be a normalized absolute path such as "/mcp", without a trailing slash, query or fragment.',
    );
  }
  return value;
}

/**
 * The URL of the metadata document the challenge names, and the check that FastMCP serves it.
 *
 * FastMCP serves the document at the well-known path and at the well-known path followed by the
 * endpoint. The RFC 9728 URL of a resource is the well-known path followed by the resource path,
 * so a resource with a path is reachable only when that path is the endpoint.
 *
 * @throws {InvalidConfigurationError} When the resource path is neither empty nor the endpoint.
 */
export function resolveMetadataUrl(resource: string, endpoint: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  if (path !== "" && path !== endpoint) {
    throw new InvalidConfigurationError(
      `Invalid configuration: the path of "resource" ("${path}") must equal "endpoint" ("${endpoint}") or be empty, because FastMCP serves the metadata document at ${WELL_KNOWN_PRM}${endpoint}. Set "endpoint" to the path of "resource".`,
    );
  }
  return new URL(`${WELL_KNOWN_PRM}${path}`, url.origin).href;
}

const REALM_PATTERN = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * Validates the realm the way `@auth0/ai-mcp` does at request time, so a bad value fails at
 * construction and not on the first request.
 * @throws {InvalidConfigurationError} When it is blank or holds characters a challenge cannot carry.
 */
export function assertRealm(realm: string | undefined): void {
  if (realm === undefined) return;
  if (typeof realm !== "string" || realm.trim() === "" || !REALM_PATTERN.test(realm)) {
    throw new InvalidConfigurationError(
      'Invalid configuration: "realm" must be a non-empty string without quotes, backslashes or control characters.',
    );
  }
}

/**
 * Validates the session binding limits.
 * @throws {InvalidConfigurationError} When a limit is not a positive finite number.
 */
export function assertSessionBinding(option: false | SessionBindingOptions | undefined): void {
  if (option === undefined || option === false) return;
  for (const name of ["maxSessions", "ttlMs"] as const) {
    const value = option[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new InvalidConfigurationError(`Invalid configuration: "sessionBinding.${name}" must be a positive number.`);
    }
  }
}
