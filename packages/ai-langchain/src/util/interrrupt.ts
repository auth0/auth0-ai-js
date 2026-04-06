import { Auth0Interrupt } from "@auth0/ai/interrupts";
import { GraphInterrupt } from "@langchain/langgraph";

import type { Interrupt, Thread } from "@langchain/langgraph-sdk";

export const toGraphInterrupt = (interrupt: Auth0Interrupt): GraphInterrupt => {
  return new GraphInterrupt([
    {
      value: interrupt
    },
  ]);
};

export const getAuth0Interrupts = (
  thread: Thread
): Interrupt<Auth0Interrupt>[] => {
  const interrupts = Object.values(thread.interrupts ?? {})
    .flat()
    .filter((i) => Auth0Interrupt.isInterrupt(i.value));
  return interrupts as Interrupt<Auth0Interrupt>[];
};
