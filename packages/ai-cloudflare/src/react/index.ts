import { useAgentChat } from "agents/ai-react";
import { UIMessage } from "ai";

import { Auth0InterruptionUI, useInterruptions } from "@auth0/ai-vercel/react";

export const useAgentChatInterruptions = <State>(
  options: Parameters<typeof useAgentChat<State>>[0]
): ReturnType<typeof useInterruptions> & ReturnType<typeof useAgentChat> => {
  const { agent } = options;

  const result = useInterruptions((handler) => {
    const onError =
      options.onError ?? ((error) => console.error("Chat error:", error));
    const { setMessages, ...rest } = useAgentChat({
      ...options,
      onError: handler(onError),
    });

    return {
      setMessages: setMessages as (
        messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])
      ) => void,
      ...rest,
    };
  }) as ReturnType<typeof useInterruptions> & ReturnType<typeof useAgentChat>;

  const { toolInterrupt } = result;
  let ti: Auth0InterruptionUI | null = null;

  if (toolInterrupt) {
    ti = {
      ...toolInterrupt,
      resume: () => {
        // Force a socket reconnect so that new tokens are sent to the agent before resuming
        agent.addEventListener(
          "open",
          () => {
            setTimeout(() => {
              toolInterrupt.resume();
            }, 500);
          },
          { once: true }
        );
        agent.reconnect();
      },
    };
  }

  // Return the wrapped chat result (which includes the useAgentChat helpers)
  // and our interrupted resume wrapper. This ensures the interruption
  // handler that set toolInterrupt is the same instance that logs errors.
  return {
    ...(result as any),
    toolInterrupt: ti,
  } as ReturnType<typeof useInterruptions> & ReturnType<typeof useAgentChat>;
};
