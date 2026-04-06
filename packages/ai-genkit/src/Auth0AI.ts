import { AuthenticationClientOptions } from "auth0";
import { z } from "genkit";
import { GenkitBeta } from "genkit/beta";

import { MemoryStore, Store, SubStore } from "@auth0/ai/stores";

import { AsyncAuthorizer } from "./AsyncAuthorization";
import { DeviceAuthorizer } from "./Device/DeviceAuthorizer";
import { FGA_AI } from "./FGA_AI";
import { TokenVaultAuthorizer } from "./TokenVault";

import type { ToolWrapper, ToolDefinition } from "./lib";

type Auth0ClientParams = Pick<
  AuthenticationClientOptions,
  "domain" | "clientId" | "clientSecret"
>;

export type CIBAParams = Omit<
  ConstructorParameters<typeof AsyncAuthorizer>[2],
  "store"
>;

export type DeviceParams = Omit<
  ConstructorParameters<typeof DeviceAuthorizer>[2],
  "store"
>;

export type TokenVaultParams = Omit<
  ConstructorParameters<typeof TokenVaultAuthorizer>[2],
  "store"
>;

type Auth0AIParams = {
  auth0?: Partial<Auth0ClientParams>;
  store?: Store;
  genkit: GenkitBeta;
};

export class Auth0AI {
  private config: Partial<Auth0ClientParams>;
  private store: SubStore;
  private genkit: GenkitBeta;

  constructor({ auth0, store, genkit }: Auth0AIParams) {
    this.config = auth0 ?? {};
    this.store = new SubStore(store ?? new MemoryStore());
    this.genkit = genkit;
  }

  /**
   *
   * Returns a tool authorizer that protects the tool
   * with the Client Initiated Base Authentication (CIBA) authorization control.
   *
   * @param params - The parameters for the CIBA authorization control.
   * @returns A tool authorizer.
   */
  withAsyncAuthorization(params: CIBAParams): ToolWrapper;

  /**
   *
   * Protects a tool function with Client Initiated Base Authentication (CIBA) authorization control.
   *
   * @param params - The parameters for the CIBA authorization control.
   * @param tool - The tool to protect.
   * @returns The protected tool.
   */
  withAsyncAuthorization<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    params: CIBAParams,
    toolConfig?: ToolDefinition<I, O>[0],
    toolFn?: ToolDefinition<I, O>[1]
  ): ToolDefinition<I, O>;

  /**
   *
   * Builds an Client Initiated Base Authentication (CIBA) authorizer for a tool.
   * if a tool is provided, the authorizer is applied to the tool.
   * @param params - The parameters for the FGA authorization control.
   * @param tool - The tool function to protect.
   * @returns
   */
  withAsyncAuthorization<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    params: CIBAParams,
    toolConfig?: ToolDefinition<I, O>[0],
    toolFn?: ToolDefinition<I, O>[1]
  ) {
    const cibaStore = this.store.createSubStore("AUTH0_AI_CIBA");
    const authorizer = new AsyncAuthorizer(this.genkit, this.config, {
      store: cibaStore,
      ...params,
    });
    if (toolConfig && toolFn) {
      return authorizer.authorizer()(toolConfig, toolFn);
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
  withDeviceAuthorizationFlow<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    params: DeviceParams,
    toolConfig?: ToolDefinition<I, O>[0],
    toolFn?: ToolDefinition<I, O>[1]
  ): ToolDefinition<I, O>;

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
  withDeviceAuthorizationFlow<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    params: DeviceParams,
    toolConfig?: ToolDefinition<I, O>[0],
    toolFn?: ToolDefinition<I, O>[1]
  ) {
    const deviceAuthorizerStore = this.store.createSubStore(
      "AUTH0_AI_DEVICE_FLOW"
    );
    const authorizer = new DeviceAuthorizer(this.genkit, this.config, {
      store: deviceAuthorizerStore,
      ...params,
    });
    if (toolConfig && toolFn) {
      return authorizer.authorizer()(toolConfig, toolFn);
    }
    return authorizer.authorizer();
  }

  /**
   * Builds a Token Vault authorizer for a tool.
   *
   * @param params - The Token Vault authorizer options.
   * @returns The authorizer.
   */
  withTokenVault(params: TokenVaultParams): ToolWrapper;

  /**
   * Protects a tool with the Token Vault authorizer.
   *
   * @param params - The Token Vault authorizer options.
   * @param tool - The tool to protect.
   * @returns The protected tool.
   */
  withTokenVault<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    params: TokenVaultParams,
    toolConfig?: ToolDefinition<I, O>[0],
    toolFn?: ToolDefinition<I, O>[1]
  ): ToolDefinition<I, O>;

  withTokenVault<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    params: TokenVaultParams,
    toolConfig?: ToolDefinition<I, O>[0],
    toolFn?: ToolDefinition<I, O>[1]
  ) {
    const store = this.store.createSubStore("AUTH0_AI_TOKEN_VAULT");
    const fc = new TokenVaultAuthorizer(this.genkit, this.config, {
      store,
      ...params,
    });
    const authorizer = fc.authorizer();
    if (toolConfig && toolFn) {
      return authorizer(toolConfig, toolFn);
    }
    return authorizer;
  }

  static FGA = FGA_AI;
}
