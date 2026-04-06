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
};

export const asyncLocalStorage = new AsyncLocalStorage<
  AsyncStorageValue<any>
>();

export const getDeviceAuthorizerCredentials = () => {
  const t = asyncLocalStorage.getStore();
  if (typeof t === "undefined") {
    throw new Error(
      "The tool must be wrapped with the withAsyncAuthorization function."
    );
  }
  return t.credentials;
};
