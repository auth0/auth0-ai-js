import { UIMessage } from "ai";
import { Settings } from "llamaindex";

import { TokenVaultInterrupt } from "@auth0/ai/interrupts";

type ExecuteFN = (dataStream: any) => Promise<void> | void;
type ExecutionErrorType = new (...args: any[]) => any;

export function withInterruptions(
  fn: ExecuteFN,
  config: {
    messages: UIMessage[];
    errorType: ExecutionErrorType;
  }
) {
  return async (dataStream: any): Promise<void> => {
    let hasToolCall = false;
    let interruption: TokenVaultInterrupt | undefined;
    const toolMeta: any = {};

    function onLLMToolCall(event: CustomEvent) {
      hasToolCall = true;
      toolMeta.toolName = event.detail.toolCall.name;
      toolMeta.toolCallId = event.detail.toolCall.id;
      toolMeta.toolArgs = event.detail.toolCall.input;
    }
    function onLLMToolResult(event: CustomEvent) {
      const { toolResult } = event.detail;

      if (toolResult.output.name === "AUTH0_AI_INTERRUPT") {
        interruption = toolResult.output;
      }
    }
    Settings.callbackManager
      .on("llm-tool-call", onLLMToolCall)
      .on("llm-tool-result", onLLMToolResult);

    await fn(dataStream);

    Settings.callbackManager.off("llm-tool-call", onLLMToolCall);
    Settings.callbackManager.off("llm-tool-result", onLLMToolResult);

    if (hasToolCall && interruption) {
      throw new config.errorType({
        message: interruption.message,
        toolName: toolMeta.toolName,
        toolArgs: toolMeta.toolArgs,
        toolCallId: `${config.messages[config.messages.length - 1].id}-${toolMeta.toolCallId}`,
        cause: new TokenVaultInterrupt(interruption.message, {
          connection: interruption.connection,
          scopes: interruption.scopes,
          requiredScopes: interruption.requiredScopes,
          authorizationParams: interruption.authorizationParams,
          behavior: "reload"
        }),
      });
    }
  };
}
