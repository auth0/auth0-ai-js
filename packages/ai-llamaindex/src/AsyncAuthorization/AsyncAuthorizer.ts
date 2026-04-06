import { AsyncAuthorizerBase } from "@auth0/ai/AsyncAuthorization";

import { createToolWrapper } from "../lib";
import { ToolWrapper } from "../types";

/**
 * The AsyncAuthorizer class implements the CIBA authorization flow for a LlamaIndex tool.
 *
 * CIBA (Client Initiated Backchannel Authentication) is a protocol that allows a client to
 * request authorization from the user via an out-of-band channel.
 */
export class AsyncAuthorizer extends AsyncAuthorizerBase<
  [any, object | undefined]
> {
  /**
   *
   * Builds a tool authorizer that protects the tool execution with the CIBA authorization flow.
   *
   * @returns A tool authorizer.
   */
  authorizer(): ToolWrapper {
    return createToolWrapper(this.protect.bind(this));
  }
}
