import type {
  ApiClient,
  ApiClientOptions,
  IndexedTokenStore,
  OnBehalfOfTokenResult,
  ScopeMatching as CoreScopeMatching,
  TokenSet,
  TokenStore,
} from '@auth0/auth0-api-js';

/**
 * How a cached On Behalf Of token is matched against a request. Same type as the
 * core package uses; `'non_strict'` requires an {@link IndexedTokenStore}.
 */
export type ScopeMatching = CoreScopeMatching;

/**
 * Organization enforcement applied when an access token is verified. Derived from
 * the core client options so the two cannot drift apart.
 *
 * - `'allow'`: no organization check.
 * - `'required'`: the token must carry an `org_id` claim, and when
 *   {@link McpClientOptions.organizationId} is set the claim must be in that list.
 */
export type OrganizationPolicy = NonNullable<ApiClientOptions['organizationPolicy']>;

/**
 * The identity of the caller, resolved from a verified access token.
 * It holds no credential and is safe to log.
 */
export interface Principal {
  /** The `sub` claim: the user or client the token was issued for. Never blank. */
  readonly sub: string;
  /** Token expiry as epoch seconds (the `exp` claim). */
  readonly expiresAt: number;
  /** Scopes parsed from the space-delimited `scope` claim. Empty when the claim is absent. */
  readonly scopes: readonly string[];
  /**
   * RBAC permissions from the `permissions` claim. `null` when the claim is absent,
   * meaning permissions are unknown. An empty array means the caller has none.
   */
  readonly permissions: readonly string[] | null;
  /**
   * The OAuth client the token was issued to. Taken from the `azp` claim (what
   * Auth0 access tokens carry), falling back to `client_id`. `null` when neither is present.
   */
  readonly clientId: string | null;
  /** The `org_id` claim. `null` when the token was not issued in an organization context. */
  readonly orgId: string | null;
}

/** Options for exchanging the caller's token for a token to a downstream API. */
export interface OnBehalfOfOptions {
  /** Identifier of the downstream API the new token is for. */
  audience: string;
  /** Space-separated scopes to request. */
  scope?: string;
}

/** Options for obtaining a token for the server itself, with no caller involved. */
export interface ClientCredentialsOptions {
  /** Identifier of the API the token is for. */
  audience: string;
  /** Space-separated scopes to request. */
  scope?: string;
}

/** Options for obtaining a token for a third-party service through a connection (Token Vault). */
export interface TokenForConnectionOptions {
  /** Name of the connection that holds the caller's linked account. */
  connection: string;
  /** Optional hint that selects among several linked accounts. */
  loginHint?: string;
}

/**
 * Result of a client credentials grant: the core token set plus the normalized
 * list of scopes that were granted.
 */
export interface ClientCredentialsTokenResult extends TokenSet {
  /**
   * The granted scopes, deduplicated and sorted. When the server returned no
   * `scope` field this holds the normalized requested scopes (RFC 6749 section
   * 5.1). An empty `scope` string means nothing was granted and this is empty.
   */
  grantedScopes: string[];
}

/** Result of a connection token request. Tracks the core client's return type. */
export type ConnectionTokenResult = Awaited<ReturnType<ApiClient['getAccessTokenForConnection']>>;

/**
 * A client bound to a single verified request. Tool code receives this instead of
 * the shared client so it always acts for the caller who made the request.
 *
 * The verified access token is closed over by the implementation and is never
 * exposed through this interface, so tool code cannot forward or log it by accident.
 * On the MCP SDK adapter `extra.authInfo.token` is intentionally an empty string, so tools
 * call downstream APIs through this client. The SDK still exposes raw request headers,
 * including Authorization, through `extra.requestInfo.headers`; tool code must not log or
 * forward them.
 */
export interface RequestScopedMcpClient {
  /** Exchanges the caller's token for a token to a downstream API. */
  getTokenOnBehalfOf(options: OnBehalfOfOptions): Promise<OnBehalfOfTokenResult>;
  /** Obtains a token for this server using its own client credentials. */
  getClientCredentialsToken(options: ClientCredentialsOptions): Promise<ClientCredentialsTokenResult>;
  /** Obtains a token for a third-party service linked to the caller through a connection. */
  getTokenForConnection(options: TokenForConnectionOptions): Promise<ConnectionTokenResult>;
  /** Returns the identity of the caller this client is bound to. */
  getPrincipal(): Principal;
}

/** Everything a tool handler needs to know about the request it is serving. */
export interface RequestContext {
  /** The authenticated caller. */
  readonly principal: Principal;
  /** A client bound to this caller's verified token. */
  readonly mcpClient: RequestScopedMcpClient;
}

/** Options for creating an MCP client. */
export interface McpClientOptions {
  /** The Auth0 tenant domain, for example `example.auth0.com`. */
  domain: string;
  /** Identifier of this MCP server as an API. Access tokens must be issued for it. */
  audience: string;
  /** Client id of the application used for token exchanges. */
  clientId?: string;
  /** Client secret of the application used for token exchanges. */
  clientSecret?: string;
  /**
   * Cache for exchanged tokens. Omit it to exchange on every call. Must be an
   * {@link IndexedTokenStore} when `scopeMatching` is `'non_strict'`: `createMcpClient`
   * throws `InvalidConfigurationError` at construction otherwise. That check is skipped
   * when you pass your own `apiClient`, because its matching mode cannot be read; the
   * core client then throws on the first token request.
   */
  tokenStore?: TokenStore | IndexedTokenStore;
  /**
   * How a cached token is matched against a request. `'non_strict'` needs an
   * indexed `tokenStore`; see {@link McpClientOptions.tokenStore}.
   * @defaultValue `'strict'`
   */
  scopeMatching?: ScopeMatching;
  /**
   * Organization enforcement applied at ingress.
   * @defaultValue `'allow'`
   */
  organizationPolicy?: OrganizationPolicy;
  /**
   * Organization ids accepted when `organizationPolicy` is `'required'`. These are
   * `org_...` identifiers, not organization names. Setting it with any other
   * policy (including the default) makes the core client throw
   * `InvalidConfigurationError` when it is created.
   */
  organizationId?: string | string[];
  /**
   * DPoP settings forwarded to the core client. Configure this to accept
   * DPoP-bound access tokens at ingress.
   */
  dpop?: ApiClientOptions['dpop'];
  /**
   * Upper limit, in milliseconds, for each outbound HTTP request the core client makes:
   * the token exchange, discovery and JWKS fetches. The limit covers the response body
   * as well as the headers. A request that exceeds it is aborted. A stalled token exchange
   * fails as a server error (the handler answers 500), never as an authentication
   * challenge; nothing is cached, concurrent callers that shared the exchange all fail, and
   * the next call starts a new one. A stalled discovery or JWKS fetch surfaces from core as
   * a token verification failure, so at ingress it currently answers 401 `invalid_token`,
   * not 500. Must be a finite number greater than 0 and at most 2147483647, otherwise
   * `createMcpClient` throws `InvalidConfigurationError`.
   * @defaultValue `10000`
   */
  requestTimeoutMs?: number;
  /**
   * A pre-built core client, used as is. Combining it with `clientId`, `clientSecret`,
   * `scopeMatching`, `organizationPolicy`, `organizationId`, `dpop` or `requestTimeoutMs` makes
   * `createMcpClient` throw `InvalidConfigurationError`, so no setting is silently
   * ignored: configure those on the client you pass in. `tokenStore` is still honoured
   * because it is supplied per call. The client is not exposed on the returned
   * `McpClient`.
   */
  apiClient?: ApiClient;
}
