import { FunctionTool, JSONValue } from "llamaindex";

import { MemoryStore, Store, SubStore } from "@auth0/ai/stores";

import { AsyncAuthorizer } from "./AsyncAuthorization";
import { DeviceAuthorizer } from "./Device";
import { FGA_AI } from "./FGA_AI";
import { TokenVaultAuthorizer } from "./TokenVault";

import type { Auth0ClientParams } from "@auth0/ai";
type ToolWrapper = ReturnType<TokenVaultAuthorizer["authorizer"]>;
type TokenVaultParams = Omit<
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
  withAsyncAuthorization<
    T,
    R extends JSONValue | Promise<JSONValue>,
    AdditionalToolArgument extends object = object,
  >(
    params: CIBAParams,
    tool: FunctionTool<T, R, AdditionalToolArgument>
  ): FunctionTool<T, R, AdditionalToolArgument>;

  withAsyncAuthorization<
    T,
    R extends JSONValue | Promise<JSONValue>,
    AdditionalToolArgument extends object = object,
  >(params: CIBAParams, tool?: FunctionTool<T, R, AdditionalToolArgument>) {
    const cibaStore = this.store.createSubStore("AUTH0_AI_CIBA");
    const fc = new AsyncAuthorizer(this.config, { store: cibaStore, ...params });
    const authorizer = fc.authorizer();
    if (tool) {
      return authorizer(tool);
    }
    return authorizer;
  }

  /**
   * Builds a Token Vault authorizer for a tool.
   *
   * @param params - The Token Vaults authorizer options.
   * @returns The authorizer.
   */
  withTokenVault(params: TokenVaultParams): ToolWrapper;

  /**
   * Protects a tool execution with the Token Vault authorizer.
   *
   * @param params - The Token Vaults authorizer options.
   * @param tool - The tool to protect.
   * @returns The protected tool.
   */
  withTokenVault<
    T,
    R extends JSONValue | Promise<JSONValue>,
    AdditionalToolArgument extends object = object,
  >(
    params: TokenVaultParams,
    tool: FunctionTool<T, R, AdditionalToolArgument>
  ): FunctionTool<T, R, AdditionalToolArgument>;

  withTokenVault<
    T,
    R extends JSONValue | Promise<JSONValue>,
    AdditionalToolArgument extends object = object,
  >(
    params: TokenVaultParams,
    tool?: FunctionTool<T, R, AdditionalToolArgument>
  ) {
    const store = this.store.createSubStore("AUTH0_AI_TOKEN_VAULT");
    const fc = new TokenVaultAuthorizer(this.config, {
      store,
      ...params,
    });
    const authorizer = fc.authorizer();
    if (tool) {
      return authorizer(tool);
    }
    return authorizer;
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
  withDeviceAuthorizationFlow<
    T,
    R extends JSONValue | Promise<JSONValue>,
    AdditionalToolArgument extends object = object,
  >(
    params: DeviceParams,
    tool: FunctionTool<T, R, AdditionalToolArgument>
  ): FunctionTool<T, R, AdditionalToolArgument>;

  withDeviceAuthorizationFlow<
    T,
    R extends JSONValue | Promise<JSONValue>,
    AdditionalToolArgument extends object = object,
  >(params: DeviceParams, tool?: FunctionTool<T, R, AdditionalToolArgument>) {
    const deviceStore = this.store.createSubStore("AUTH0_AI_DEVICE_FLOW");
    const fc = new DeviceAuthorizer(this.config, {
      store: deviceStore,
      ...params,
    });
    const authorizer = fc.authorizer();
    if (tool) {
      return authorizer(tool);
    }
    return authorizer;
  }

  static FGA = FGA_AI;
}
