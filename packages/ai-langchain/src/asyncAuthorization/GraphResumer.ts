import { EventEmitter } from "node:events";

/* eslint-disable @typescript-eslint/ban-ts-comment */
import { AsyncAuthorizationRequest } from "@auth0/ai/AsyncAuthorization";
import {
  AsyncAuthorizationInterrupt,
  AuthorizationPendingInterrupt,
  AuthorizationPollingInterrupt,
} from "@auth0/ai/interrupts";

import { getAuth0Interrupts } from "../util/interrrupt";

import type { Interrupt, Client, Thread } from "@langchain/langgraph-sdk";

type WatchedThread = {
  // The thread ID to watch.
  id: string;

  assistantID: string;

  // The interruption ID to watch.
  interruptionID: string;

  // The authorization request to watch.
  authRequest: AsyncAuthorizationRequest;

  config: Record<string, any>;

  lastRun?: number;
};

type GraphResumerFilters = {
  graphID?: string;
};

type GraphResumerOptions = {
  langGraph: Client;
  filters?: GraphResumerFilters;
};

interface Events {
  resume: [thread: WatchedThread];
  error: [error: Error];
}

export class GraphResumer extends EventEmitter<Events> {
  private map: Map<string, WatchedThread> = new Map();
  private interval: NodeJS.Timeout | undefined = undefined;
  private params: GraphResumerOptions;

  constructor(params: GraphResumerOptions) {
    super();
    this.params = params;
  }

  private async getAllInterruptedThreads() {
    const { langGraph, filters } = this.params;
    const interruptedThreads: Thread[] = [];
    let offset = 0;
    while (true) {
      const page = await langGraph.threads.search({
        status: "interrupted",
        limit: 100,
        offset,
        metadata: filters?.graphID ? { graph_id: filters.graphID } : {},
      });
      if (page.length === 0) break;
      const cibaInterrupted = page.filter((t) => {
        const interrupt = this.getFirstInterrupt(t);
        if (!interrupt) return false;
        return (
          AsyncAuthorizationInterrupt.isInterrupt(interrupt.value) &&
          AsyncAuthorizationInterrupt.hasRequestData(interrupt.value)
        );
      });
      interruptedThreads.push(...cibaInterrupted);
      offset += page.length;
      if (page.length < 100) break;
    }
    return interruptedThreads;
  }

  private getFirstInterrupt(thread: Thread) {
    const { interrupts } = thread;
    const interrupt =
      interrupts &&
      Object.values(interrupts).length > 0 &&
      Object.values(interrupts)[0].length > 0
        ? Object.values(interrupts)[0][0]
        : undefined;
    return interrupt;
  }

  private getHashMapID(thread: Thread) {
    const { interrupts } = thread;
    return `${thread.thread_id}:${Object.keys(interrupts)[0]}`;
  }

  async loop() {
    const allThreads = await this.getAllInterruptedThreads();

    //Remove old interrupted threads
    Array.from(this.map.keys())
      .filter((k) => !allThreads.find((t) => this.getHashMapID(t) === k))
      .forEach((k) => this.map.delete(k));

    //Add new interrupted threads
    for (const thread of allThreads) {
      const interrupt = getAuth0Interrupts(thread).find(
        (i) =>
          AuthorizationPendingInterrupt.isInterrupt(i.value) ||
          AuthorizationPollingInterrupt.isInterrupt(i.value)
      ) as Interrupt<
        AuthorizationPendingInterrupt | AuthorizationPollingInterrupt
      >;
      if (!interrupt || !interrupt.value?.request) {
        continue;
      }
      const key = this.getHashMapID(thread);
      let watchedThread = this.map.get(key);
      if (!watchedThread) {
        watchedThread = {
          id: thread.thread_id,
          assistantID: thread.metadata?.graph_id as string,
          // @ts-expect-error
          config: thread.config as Record<string, any>,
          interruptionID: Object.keys(thread.interrupts)[0],
          authRequest: interrupt.value.request,
        };
        this.map.set(key, watchedThread);
        continue;
      }
    }

    const threadsToResume = Array.from(this.map.values()).filter(
      (t) =>
        !t.lastRun || t.lastRun + t.authRequest.interval * 1000 < Date.now()
    );

    await Promise.all(
      threadsToResume.map(async (t) => {
        //Note: It doesn't make sense to poll AUTH0
        // here because we need the graph to fail if the
        // user has rejected the request.
        this.emit("resume", t);
        await this.params.langGraph.runs.wait(t.id, t.assistantID, {
          input: undefined,
          config: t.config,
        });
        t.lastRun = Date.now();
      })
    );
  }

  public start(): void {
    this.interval = setInterval(async () => {
      try {
        await this.loop();
      } catch (e) {
        this.emit("error", e as Error);
      }
    }, 5000);
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }
}
