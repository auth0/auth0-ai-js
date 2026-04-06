import { AsyncLocalStorage } from "async_hooks";

import { TokenSet } from "../../credentials";

export type AsyncStorageValue<TContext> = {
  credentials?: TokenSet;

  /**
   * The tool execution context.
   */
  context: TContext;

  /**
   * The tool execution arguments.
   */
  args: any[];

  /**
   * The namespace in the Store for the CIBA authorization response.
   */
  authResponseNS: string[];
};

export const asyncLocalStorage = new AsyncLocalStorage<
  AsyncStorageValue<any>
>();

export const getAsyncAuthorizationCredentials = () => {
  const t = asyncLocalStorage.getStore();
  if (typeof t === "undefined") {
    throw new Error(
      "The tool must be wrapped with the withAsyncAuthorization function."
    );
  }
  return t.credentials;
};
