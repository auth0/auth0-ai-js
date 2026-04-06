/**
 * A key-value store interface.
 *
 * Auth0AI uses this store in different stages:
 *
 * 1. to store the authorization request when an AI agent is interrupted  (CIBA, Device Flow)
 * 2. user credentials associated to threads to avoid re-authentication (CIBA, Device Flow, Token Vault)
 *
 */

export interface Store<T = any> {
  /**
   *
   * Get a value from the store.
   *
   * @param namespace - The namespace of the key
   * @param key - The key
   */
  get(namespace: string[], key: string): Promise<T | undefined>;

  /**
   *
   * Delete a value from the store.
   * @param namespace - The namespace of the key
   * @param key - The key
   */
  delete(namespace: string[], key: string): Promise<void>;

  /**
   *
   * Put a value in the store.
   *
   * @param namespace - The namespace of the key
   * @param key - The key
   * @param value - The value to store
   * @param [options] - The options to store the value
   * @param [options.expiresIn] - The time in milliseconds to expire the value
   */
  put(
    namespace: string[],
    key: string,
    value: T,
    options?: { expiresIn?: number }
  ): Promise<void>;
}
