import { DeviceAuthorizerBase } from "@auth0/ai/Device";

import { ToolContext, ToolExecutionOptions } from "../util/ToolContext";
import { ToolWrapper } from "../util/ToolWrapper";

/**
 * The DeviceAuthorizer class implements the Device Authorization Flow for a Vercel-AI tool.
 */
export class DeviceAuthorizer extends DeviceAuthorizerBase<
  [any, ToolExecutionOptions]
> {
  /**
   *
   * Builds a tool authorizer that protects the tool execution with the CIBA authorization flow.
   *
   * @returns A tool authorizer.
   */
  authorizer(): ToolWrapper {
    return (t) => {
      return {
        ...t,
        execute: this.protect(ToolContext(t), t.execute!),
      };
    };
  }
}
