import { Schedule } from "agents";
import { UIMessage } from "ai";

import { AuthorizationPendingInterrupt, AuthorizationPollingInterrupt } from "@auth0/ai/interrupts";

type Constructor<T = object> = new (...args: any[]) => T;

type ScheduledParamsType = {
  interrupt: AuthorizationPendingInterrupt | AuthorizationPollingInterrupt;
  context: {
    threadID: string;
    toolCallID: string;
    toolName: string;
  };
};

interface ChatAgent {
  schedule<T = string>(
    when: Date | string | number,
    callback: keyof this,
    payload?: T
  ): Promise<Schedule<T>>;
  messages: UIMessage[];
  saveMessages(messages: UIMessage[]): Promise<void>;
  get name(): string;
}

/**
 * Mixin to add Async User Confirmation resuming functionality to AIChatAgent.
 *
 * This class extends the AIChatAgent to handle asynchronous user confirmation
 * resuming using the CIBA (Client Initiated Backchannel Authentication) flow.
 *
 * It schedules a check for user confirmation and updates the message state
 * accordingly.
 *
 * Call the `scheduleAsyncUserConfirmationCheck` method to initiate the scheduling from
 * within the `onAuthorizationInterrupt` callback of the authorizer.
 *
 * auth0AI.withAsyncAuthorization({
 *   onAuthorizationInterrupt: async (interrupt, context) => {
 *     const { agent } = getCurrentAgent<Chat>();
 *     agent?.schedulePoller({ interrupt, context });
 *   },
 * });
 *
 * @param Base - The base class to extend, typically an AIChatAgent.
 * @returns A new class that extends the base class with additional functionality.
 */
export const AsyncUserConfirmationResumer = <
  TBase extends Constructor<ChatAgent>,
>(
  Base: TBase
) => {
  return class extends Base {
    /**
     * Schedules an asynchronous user confirmation check.
     *
     * @param params - The parameters for the scheduled task, including the interrupt and context.
     * @param delayInSeconds - The delay in seconds before the check is executed (default to Auth request polling interval).
     * @returns A promise that resolves to a Schedule object for the scheduled task.
     */
    async scheduleAsyncUserConfirmationCheck(
      params: ScheduledParamsType,
      delayInSeconds?: number
    ): Promise<Schedule<ScheduledParamsType>> {
      return this.schedule(
        delayInSeconds ?? params.interrupt.request.interval ?? 60,
        "asyncUserConfirmationCheck",
        params
      );
    }

    /**
     * Method run by the scheduler to check for user confirmation.
     * @param params - The parameters for the scheduled task, including the interrupt and context.
     * @returns
     */
    async asyncUserConfirmationCheck(params: {
      interrupt: AuthorizationPendingInterrupt | AuthorizationPollingInterrupt;
      context: { threadID: string; toolCallID: string; toolName: string };
    }): Promise<void> {
      const message = this.messages.find((m) =>
        m.parts?.some(
          (p) =>
            p.type.startsWith("tool-") && "toolCallId" in p &&
            p.toolCallId === params.context.toolCallID
        )
      );
      if (!message) {
        return;
      }

      const newMessage = {
        ...message,
        parts: message.parts?.map((p) => {
          if (p.type.startsWith("tool-") && "toolCallId" in p &&
            p.toolCallId === params.context.toolCallID) {
              return {
                  ...p,
                  toolInvocation: {
                    ...p,
                    state: "output-available",
                    output: { continueInterruption: true },
                  },
                }
              }
          return p;
        }
      )
      };

      const newMessages = this.messages.map((m, index) =>
        index === this.messages.indexOf(message) ? newMessage : m
      );

      await this.saveMessages(newMessages as UIMessage[]);
    }
  };
};
