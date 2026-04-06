import { GenkitBeta } from "genkit/beta";

import { AsyncAuthorizerBase } from "@auth0/ai/AsyncAuthorization";
import { AuthorizationPendingInterrupt, AuthorizationPollingInterrupt } from "@auth0/ai/interrupts";
import { ToolFnOptions, ToolRunOptions } from "@genkit-ai/ai/tool";

import { createToolWrapper, toGenKitInterrupt, ToolWrapper } from "../lib";

/**
 * The AsyncAuthorizer class implements the CIBA authorization flow for a Genkit AI tool.
 *
 * CIBA (Client Initiated Backchannel Authentication) is a protocol that allows a client to
 * request authorization from the user via an out-of-band channel.
 */
export class AsyncAuthorizer extends AsyncAuthorizerBase<
  [any, ToolFnOptions & ToolRunOptions]
> {
  constructor(
    private readonly genkit: GenkitBeta,
    ...args: ConstructorParameters<typeof AsyncAuthorizerBase>
  ) {
    super(...args);
  }

  protected async handleAuthorizationInterrupts(
    err: AuthorizationPendingInterrupt | AuthorizationPollingInterrupt
  ) {
    throw toGenKitInterrupt(err);
  }
  /**
   *
   * Builds a tool authorizer that protects the tool execution with the CIBA authorization flow.
   *
   * @returns A tool authorizer.
   */
  authorizer(): ToolWrapper {
    return createToolWrapper(this.genkit, this.protect.bind(this));
  }
}
