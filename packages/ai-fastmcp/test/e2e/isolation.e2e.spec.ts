/**
 * Callers stay apart through a real FastMCP server, against the real tenant. Four distinct
 * subjects (two users, two clients) call at the same time with random delays inside the tool. Every
 * call must see its own caller through the session, through the accessors of `@auth0/ai-mcp` and
 * through the client bound to the call, and every exchange must be made for, and cached under,
 * the caller that asked for it.
 */
import { MemoryIndexedTokenStore } from "@auth0/ai-mcp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LIMITED_CLIENT_VARS,
  SECOND_USER_VARS,
  TESTER_CLIENT_VARS,
  callTool,
  connect,
  describeLive,
  firstUser,
  installFetchCounter,
  limitedClient,
  secondUser,
  startDownstreamApi,
  startFastMcpServer,
  subjectOf,
  testerClient,
} from "./support/index.js";
import type {
  Caller,
  DelegateResult,
  DownstreamApi,
  DownstreamClaimsBody,
  FastMcpServer,
  FetchCounter,
  Session,
  WhoamiResult,
} from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

/** A small seeded generator, so a failing run can be repeated with the seed in the message. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Live {
  caller: Caller;
  token: string;
  sub: string;
  session: Session;
}

describeLive(
  "fastmcp isolation between callers",
  [...SECOND_USER_VARS, ...LIMITED_CLIENT_VARS, ...TESTER_CLIENT_VARS],
  (e2e) => {
    const callers: Caller[] = [firstUser(e2e), secondUser(e2e), limitedClient(e2e), testerClient(e2e)];
    let downstream: DownstreamApi;
    let tokens: string[] = [];

    beforeAll(async () => {
      downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
      tokens = await Promise.all(callers.map((caller) => caller.token()));
    });

    afterAll(async () => {
      await downstream?.close();
    });

    describe.each(MODES)("$label server", ({ stateless }) => {
      let counter: FetchCounter | undefined;
      let server: FastMcpServer | undefined;
      let store: MemoryIndexedTokenStore;
      let live: Live[] = [];

      async function boot(): Promise<void> {
        counter = installFetchCounter();
        store = new MemoryIndexedTokenStore();
        server = await startFastMcpServer({
          env: e2e,
          downstreamUrl: downstream.url,
          stateless,
          clientOptions: { tokenStore: store },
        });
        live = [];
        for (const [index, caller] of callers.entries()) {
          const token = tokens[index]!;
          live.push({ caller, token, sub: subjectOf(token), session: await connect(server, token) });
        }
        downstream.calls.length = 0;
      }

      afterEach(async () => {
        counter?.restore();
        for (const entry of live) await entry.session.close();
        await server?.stop();
        counter = undefined;
        server = undefined;
        live = [];
        downstream.calls.length = 0;
      });

      it("FM-04 the four callers have four distinct subjects", () => {
        const subs = tokens.map(subjectOf);
        expect(new Set(subs).size).toBe(4);
      });

      it("FM-04 four callers at once: every call sees its own caller, scopes and client", async () => {
        await boot();
        const results = await Promise.all(
          live.flatMap((entry) =>
            Array.from({ length: 5 }, (_, round) =>
              callTool<WhoamiResult>(entry.session, "whoami", { delayMs: (round * 7) % 23 }).then((outcome) => ({
                entry,
                outcome,
              })),
            ),
          ),
        );
        expect(results).toHaveLength(20);
        for (const { entry, outcome } of results) {
          const label = entry.caller.name;
          expect(outcome.isError, label).toBe(false);
          expect(outcome.value.sessionSub, label).toBe(entry.sub);
          expect(outcome.value.accessorSub, label).toBe(entry.sub);
          expect(outcome.value.clientSub, label).toBe(entry.sub);
          expect(outcome.value.clientId, label).toBe(entry.caller.clientId);
          expect([...outcome.value.scopes].sort(), label).toEqual([...entry.caller.scopes].sort());
        }
      });

      it("FM-04 two users exchange at the same time: each downstream call carries its own subject, each is cached under its own user", async () => {
        await boot();
        counter!.reset();
        const users = live.filter((entry) => entry.caller.kind === "user");
        expect(users).toHaveLength(2);
        const results = await Promise.all(
          users.flatMap((entry) =>
            Array.from({ length: 3 }, () =>
              callTool<DelegateResult>(entry.session, "delegate", { scope: "work:read" }).then((outcome) => ({
                entry,
                outcome,
              })),
            ),
          ),
        );
        for (const { entry, outcome } of results) {
          expect(outcome.isError, entry.caller.name).toBe(false);
          expect(outcome.value.status, entry.caller.name).toBe(200);
          expect((outcome.value.body as unknown as DownstreamClaimsBody).sub, entry.caller.name).toBe(entry.sub);
        }
        const seen = downstream.calls.map((call) => call.claims?.sub).sort();
        expect(seen).toEqual(users.flatMap((entry) => [entry.sub, entry.sub, entry.sub]).sort());
        // One exchange per user: single-flight and the store never merge two callers.
        expect(counter!.exchanges).toBe(2);
        expect(store.size).toBe(2);
      });

      it("FM-12 sixty calls with random delays: the session, the accessor and the bound client agree on the caller every time", async () => {
        await boot();
        const seed = Date.now() % 100000;
        const random = seeded(seed);
        const results = await Promise.all(
          live.flatMap((entry) =>
            Array.from({ length: 15 }, async () => {
              const delayMs = Math.floor(random() * 60);
              const outcome = await callTool<WhoamiResult>(entry.session, "whoami", { delayMs });
              return { entry, outcome, delayMs };
            }),
          ),
        );
        expect(results).toHaveLength(60);
        const wrong = results.filter(
          ({ entry, outcome }) =>
            outcome.isError ||
            outcome.value.sessionSub !== entry.sub ||
            outcome.value.accessorSub !== entry.sub ||
            outcome.value.clientSub !== entry.sub,
        );
        expect(wrong.length, `calls that saw another caller (seed ${seed})`).toBe(0);
      });
    });
  },
);
