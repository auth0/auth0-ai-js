import { FGAAuthorizerBase } from "@auth0/ai/FGA";

import { ToolExecutionOptions } from "../util/ToolContext";
import { ToolWrapper } from "../util/ToolWrapper";

/**
 * The FGAAuthorizer class implements the FGA authorization control for a Vercel AI tool.
 *
 * This class extends the FGAAuthorizerBase and provides a method to build a tool authorizer
 * that protects the tool execution using FGA.
 *
 */
export class FGAAuthorizer extends FGAAuthorizerBase<
  [any, ToolExecutionOptions]
> {
  /**
   *
   * Builds a tool authorizer that protects the tool execution with FGA.
   *
   * @returns A tool authorizer.
   */
  authorizer(): ToolWrapper {
    return (t) => {
      return {
        ...t,
        execute: this.protect(t.execute!),
      };
    };
  }
}
