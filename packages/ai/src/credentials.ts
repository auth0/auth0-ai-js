export interface AuthorizationDetails {
  readonly type: string;
  readonly [parameter: string]: unknown;
}

export type TokenResponse = {
  /** Bearer token for API authorization */
  access_token: string;
  /** Refresh token (requires `offline_access` scope) */
  refresh_token?: string;
  /** JWT containing user identity claims */
  id_token: string;
  /** Typically "Bearer" */
  token_type?: string;
  /** Token validity in seconds (default: 86400) */
  expires_in: number;
  /** Granted permissions space */
  scope: string;
  /** Granted authorization details */
  authorization_details?: AuthorizationDetails[];
};

/**
 * Represents a set of authentication tokens returned after a successful authentication flow.
 *
 * @interface TokenSet
 * @property {string[]} [scopes] - Optional array of permission scopes granted for the token.
 * @property {string} [idToken] - Optional JWT ID token containing user claims.
 * @property {string} [refreshToken] - Optional token used to obtain new access tokens without re-authentication.
 * @property {number} [expiresIn] - Optional time in seconds until the access token expires.
 * @property {string} accessToken - The access token string used for API requests.
 * @property {string} tokenType - The type of the token, typically "Bearer".
 * @property {AuthorizationDetails[]} [authorizationDetails] - Optional array of authorization details granted for the token.
 */
export interface TokenSet {
  scopes?: string[];
  idToken?: string;
  refreshToken?: string;

  expiresIn?: number;
  accessToken: string;
  tokenType: string;

  authorizationDetails?: AuthorizationDetails[];
}

export const tokenSetFromTokenResponse = (tr: TokenResponse): TokenSet => {
  return {
    tokenType: tr.token_type ?? "Bearer",
    accessToken: tr.access_token,
    idToken: tr.id_token,
    refreshToken: tr.refresh_token,
    expiresIn: tr.expires_in,
    scopes: tr.scope ? tr.scope.split(" ") : undefined,
    ...(tr.authorization_details
      ? { authorizationDetails: tr.authorization_details }
      : {}),
  };
};
