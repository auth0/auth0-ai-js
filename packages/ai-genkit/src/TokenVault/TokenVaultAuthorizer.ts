import { GenkitBeta } from "genkit/beta";

import { Auth0Interrupt } from "@auth0/ai/interrupts";
import { TokenVaultAuthorizerBase } from "@auth0/ai/TokenVault";
import { ToolFnOptions, ToolRunOptions } from "@genkit-ai/ai/tool";

import { createToolWrapper, toGenKitInterrupt, ToolWrapper } from "../lib";

export class TokenVaultAuthorizer extends TokenVaultAuthorizerBase<
  [any, ToolFnOptions & ToolRunOptions]
> {
  constructor(
    private readonly genkit: GenkitBeta,
    ...args: ConstructorParameters<typeof TokenVaultAuthorizerBase>
  ) {
    super(...args);
  }

  protected handleAuthorizationInterrupts(err: Auth0Interrupt) {
    throw toGenKitInterrupt(err);
  }

  /**
   *
   * Builds a tool authorizer that protects the tool execution with the Token Vault Authorizer.
   *
   * @returns A tool authorizer.
   */
  authorizer(): ToolWrapper {
    return createToolWrapper(this.genkit, this.protect.bind(this));
  }
}
