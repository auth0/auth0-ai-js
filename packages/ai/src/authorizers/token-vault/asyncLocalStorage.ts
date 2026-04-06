import { AsyncLocalStorage } from "node:async_hooks";

import { TokenSet } from "../../credentials";
import { TokenVaultError } from "../../interrupts";
import { ToolCallContext } from "../context";

export type AsyncStorageValue = {
  /**
   * The Token Vault access token.
   */
  credentials?: TokenSet;

  /**
   * The tool execution context.
   */
  context: ToolCallContext;

  /**
   * The token vault name.
   */
  connection: string;

  /**
   * The scopes required to access the token vault.
   */
  scopes: string[];

  /**
   * The scopes that the current access token has.
   */
  currentScopes?: string[];

  /**
   * Additional authorization parameters to be passed during token acquisition.
   */
  authorizationParams?: Record<string, string>;
};

export const asyncLocalStorage = new AsyncLocalStorage<AsyncStorageValue>();

/**
 * Returns the entire tokenset for the current connection.
 *
 * Use `getAccessTokenFromTokenVault` if you only need the access token.
 *
 * @returns {TokenSet} The current token set.
 */
export const getCredentialsFromTokenVault = () => {
  const store = asyncLocalStorage.getStore();
  if (typeof store === "undefined") {
    throw new Error(
      "The tool must be wrapped with the withTokenVault function."
    );
  }
  return store?.credentials;
};

/**
 *
 * Get the access token for the current connection.
 *
 * @returns The access token for the current connection.
 */
export const getAccessTokenFromTokenVault = () => {
  const credentials = getCredentialsFromTokenVault();
  if (!credentials || !credentials.accessToken) {
    throw new TokenVaultError("No credentials found");
  }
  return credentials.accessToken;
};
