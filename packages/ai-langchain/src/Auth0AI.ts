import { Auth0ClientParams } from "@auth0/ai";
import { MemoryStore, Store, SubStore } from "@auth0/ai/stores";

import { AsyncAuthorizer } from "./asyncAuthorization";
import { DeviceAuthorizer } from "./Device";
import { FGA_AI } from "./FGA_AI";
import { TokenVaultAuthorizer } from "./TokenVault";
import { ToolLike, ToolWrapper } from "./util/ToolWrapper";

export type TokenVaultAuthorizerParams = Omit<
  ConstructorParameters<typeof TokenVaultAuthorizer>[1],
  "store"
>;

export type CIBAParams = Omit<
  ConstructorParameters<typeof AsyncAuthorizer>[1],
  "store"
>;

export type DeviceParams = Omit<
  ConstructorParameters<typeof DeviceAuthorizer>[1],
  "store"
>;

type Auth0AIParams = {
  auth0?: Partial<Auth0ClientParams>;
  store?: Store;
};

export class Auth0AI {
  private config: Partial<Auth0ClientParams>;
  private store: SubStore;

  constructor({ auth0, store }: Auth0AIParams = {}) {
    this.config = auth0 ?? {};
    this.store = new SubStore(store ?? new MemoryStore());
  }

  /**
   * Builds a CIBA Authorizer for a tool.
   * @param params - The CIBA authorizer options.
   * @returns - The authorizer.
   */
  withAsyncAuthorization(params: CIBAParams): ToolWrapper;

  /**
   * Protects a tool with the CIBA authorizer.
   * @param params - The CIBA authorizer options.
   * @param tool - The tool to protect.
   * @returns The protected tool.
   */
  withAsyncAuthorization<ToolType extends ToolLike>(
    params: CIBAParams,
    tool: ToolType
  ): ToolType;

  /**
   *
   * Builds a CIBA Authorizer for a tool.
   * If a tool is provided, it will be protected with the CIBA authorizer.
   * Otherwise the authorizer will be returned.
   *
   * @param options - The CIBA authorizer options.
   * @param [tool] - The tool to protect.
   * @returns The authorizer or the protected tool.
   */
  withAsyncAuthorization<ToolType extends ToolLike>(
    options: CIBAParams,
    tool?: ToolType
  ) {
    const cibaStore = this.store.createSubStore("AUTH0_AI_CIBA");
    const authorizer = new AsyncAuthorizer(this.config, {
      store: cibaStore,
      ...options,
    });
    if (tool) {
      return authorizer.authorizer()(tool);
    }
    return authorizer.authorizer();
  }

  /**
   * Builds a Token Vault authorizer for a tool.
   *
   * @param params - The Token Vault authorizer options.
   * @returns The authorizer.
   */
  withTokenVault(
    params: TokenVaultAuthorizerParams
  ): ToolWrapper;

  /**
   * Protects a tool execution with the Token Vault authorizer.
   *
   * @param params - The Token Vault authorizer options.
   * @param tool - The tool to protect.
   * @returns The protected tool.
   */
  withTokenVault<ToolType extends ToolLike>(
    params: TokenVaultAuthorizerParams,
    tool: ToolType
  ): ToolType;

  /**
   * Protects a tool execution with the Token Vault authorizer.
   *
   * @param options - The Token Vault authorizer options.
   * @returns The authorizer.
   */
  withTokenVault<ToolType extends ToolLike>(
    options: TokenVaultAuthorizerParams,
    tool?: ToolType
  ) {
    const store = this.store.createSubStore("AUTH0_AI_TOKEN_VAULT");
    const authorizer = new TokenVaultAuthorizer(this.config, {
      store,
      ...options,
    });
    if (tool) {
      return authorizer.authorizer()(tool);
    }
    return authorizer.authorizer();
  }

  /**
   * Builds a Device Flow Authorizer for a tool.
   *
   * @param params - The Device Flow Authorizer options.
   * @returns - The authorizer.
   */
  withDeviceAuthorizationFlow(params: DeviceParams): ToolWrapper;

  /**
   * Protects a tool with the Device Flow Authorizer.
   * @param params - The Device Flow Authorizer options.
   * @param tool - The tool to protect.
   * @returns The protected tool.
   */
  withDeviceAuthorizationFlow<ToolType extends ToolLike>(
    params: DeviceParams,
    tool: ToolType
  ): ToolType;

  /**
   *
   * Builds a Device Flow Authorizer for a tool.
   * If a tool is provided, it will be protected with the Device Flow Authorizer.
   * Otherwise the authorizer will be returned.
   *
   * @param options - The Device Flow Authorizer options.
   * @param [tool] - The tool to protect.
   * @returns The authorizer or the protected tool.
   */
  withDeviceAuthorizationFlow<ToolType extends ToolLike>(
    options: DeviceParams,
    tool?: ToolType
  ) {
    const deviceAuthorizerStore = this.store.createSubStore(
      "AUTH0_AI_DEVICE_FLOW"
    );
    const authorizer = new DeviceAuthorizer(this.config, {
      store: deviceAuthorizerStore,
      ...options,
    });
    if (tool) {
      return authorizer.authorizer()(tool);
    }
    return authorizer.authorizer();
  }

  static FGA = FGA_AI;
}
