import { TokenVaultAuthorizerBase } from "@auth0/ai/TokenVault";

import { ToolContext, ToolExecutionOptions } from "../util/ToolContext";
import { ToolWrapper } from "../util/ToolWrapper";

export class TokenVaultAuthorizer extends TokenVaultAuthorizerBase<
  [any, ToolExecutionOptions]
> {
  authorizer(): ToolWrapper {
    return (t) => {
      return {
        ...t,
        execute: this.protect(ToolContext(t), t.execute!),
      };
    };
  }
}
