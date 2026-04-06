import { AsyncAuthorizerBase } from "@auth0/ai/AsyncAuthorization";
import { AuthorizationPendingInterrupt, AuthorizationPollingInterrupt } from "@auth0/ai/interrupts";
import { tool } from "@langchain/core/tools";

import { toGraphInterrupt } from "../util/interrrupt";
import { ToolContext } from "../util/ToolContext";
import { ToolLike, ToolWrapper } from "../util/ToolWrapper";

/**
 * Authorizer for token vaults.
 */
export class AsyncAuthorizer extends AsyncAuthorizerBase<[any, any]> {
  protected override async handleAuthorizationInterrupts(
    err: AuthorizationPendingInterrupt | AuthorizationPollingInterrupt
  ) {
    throw toGraphInterrupt(err);
  }

  authorizer(): ToolWrapper {
    return <T extends ToolLike>(t: T) => {
      const getContext = ToolContext(t);
      const protectedFunc = this.protect(getContext, t.invoke.bind(t));
      return tool(protectedFunc, {
        name: t.name,
        description: t.description,
        schema: t.schema,
      }) as unknown as T;
    };
  }
}
