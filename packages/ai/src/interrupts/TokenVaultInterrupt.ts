import { Auth0Interrupt } from "./Auth0Interrupt";

/**
 * Error thrown when a tool call requires an access token for an external service.
 *
 * Throw this error if the service returns Unauthorized for the current access token.
 */
export class TokenVaultInterrupt extends Auth0Interrupt {
  /**
   * The auth0 connection name.
   */
  public readonly connection: string;

  /**
   * The scopes required to access the external service as stated
   * in the authorizer.
   */
  public readonly scopes: string[];

  /**
   * The union between the current scopes of the Access Token plus the required scopes.
   * This is the list of scopes that will be used to request a new Access Token.
   */
  public readonly requiredScopes: string[];

  /**
   * Additional authorization parameters to be passed during token acquisition.
   */
  public readonly authorizationParams: Record<string, string>;

  public readonly behavior: "resume" | "reload";

  public static code = "TOKEN_VAULT_ERROR" as const;

  constructor(message: string, params: {
    connection: string;
    scopes: string[];
    requiredScopes: string[];
    authorizationParams?: Record<string, string>;
    behavior?: "resume" | "reload";
  }) {
    super(message, TokenVaultInterrupt.code);
    this.connection = params.connection;
    this.scopes = params.scopes;
    this.requiredScopes = params.requiredScopes;
    this.authorizationParams = { ...(params.authorizationParams ?? {}) };
    this.behavior = params.behavior ?? "resume";
  }
}

/**
 * Error thrown when a tool call requires an access token for an external service.
 *
 * The authorizer will automatically convert this class of error to TokenVaultInterrupt.
 */
export class TokenVaultError extends Error {
  constructor(message: string) {
    super(message);
  }
}
