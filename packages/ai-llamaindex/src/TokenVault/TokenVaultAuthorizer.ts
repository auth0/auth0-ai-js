import { Auth0Interrupt } from "@auth0/ai/interrupts";
import { TokenVaultAuthorizerBase } from "@auth0/ai/TokenVault";

import { createToolWrapper } from "../lib";
import { ToolWrapper } from "../types";

export class TokenVaultAuthorizer extends TokenVaultAuthorizerBase<
  [any, object | undefined]
> {
  authorizer(): ToolWrapper {
    return createToolWrapper(this.protect.bind(this));
  }

  handleAuthorizationInterrupts(err: Auth0Interrupt) {
    return err;
  }
}
