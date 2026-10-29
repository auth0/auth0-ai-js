import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callTool, connect, createBarrier, createRig, withServer } from "./harness.js";
import type { Session } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

const MODES = [{ stateless: true }, { stateless: false }];
const CALLERS = ["user|alice", "user|bob", "user|carol", "user|dave"];

interface Report {
  sessionSub: string | null;
  accessorSub: string | null;
  clientSub: string | null;
  scopes: string[] | null;
}

interface RawReport {
  sessionSub: string | null;
  accessorSub: string | null;
  clientBound: boolean;
}

async function connectAll(server: Parameters<typeof connect>[0] & { audience: string }): Promise<Array<{ sub: string; session: Session }>> {
  return Promise.all(
    CALLERS.map(async (sub, i) => ({
      sub,
      session: await connect(server, await rig().token(server, { sub, scope: `read:orders caller:${i}` })),
    })),
  );
}

describe.each(MODES)("caller isolation (stateless: $stateless)", ({ stateless }) => {
  it("keeps 40 concurrent calls from 4 callers apart in the session, the accessors and the scoped client", async () => {
    // The barrier holds every call inside the tool until all 40 have arrived.
    await withServer({ stateless, barrier: createBarrier(40) }, async (server) => {
      const callers = await connectAll(server);
      try {
        const calls = callers.flatMap(({ sub, session }, caller) =>
          Array.from({ length: 10 }, (_unused, i) =>
            callTool<Report>(session, "whoami", { delay: (i * 7 + caller * 3) % 25 }).then((outcome) => ({ sub, caller, outcome })),
          ),
        );
        const results = await Promise.all(calls);
        expect(results).toHaveLength(40);
        for (const { sub, caller, outcome } of results) {
          expect(outcome.isError).toBe(false);
          expect(outcome.value).toEqual({
            sessionSub: sub,
            accessorSub: sub,
            clientSub: sub,
            scopes: ["read:orders", `caller:${caller}`],
          });
        }
      } finally {
        await Promise.all(callers.map(({ session }) => session.close()));
      }
    });
  });

  it("does not leak a context into a tool that is not wrapped", async () => {
    await withServer({ stateless, barrier: createBarrier(40) }, async (server) => {
      const callers = await connectAll(server);
      try {
        const results = await Promise.all(
          callers.flatMap(({ sub, session }) =>
            Array.from({ length: 10 }, (_unused, i) =>
              callTool<RawReport>(session, "whoami_raw", { delay: i * 2 }).then((outcome) => ({ sub, outcome })),
            ),
          ),
        );
        expect(results).toHaveLength(40);
        for (const { sub, outcome } of results) {
          // The session is right; the accessors know nothing without the wrapper.
          expect(outcome.value).toEqual({ sessionSub: sub, accessorSub: null, clientBound: false });
        }
      } finally {
        await Promise.all(callers.map(({ session }) => session.close()));
      }
    });
  });

  it("keeps wrapped and unwrapped calls apart when they run together", async () => {
    await withServer({ stateless }, async (server) => {
      const callers = await connectAll(server);
      try {
        const results = await Promise.all(
          callers.flatMap(({ sub, session }) => [
            callTool<Report>(session, "whoami", { delay: 15 }).then((outcome) => ({ kind: "wrapped", sub, outcome })),
            callTool<RawReport>(session, "whoami_raw", { delay: 5 }).then((outcome) => ({ kind: "raw", sub, outcome })),
            callTool<Report>(session, "whoami").then((outcome) => ({ kind: "wrapped", sub, outcome })),
          ]),
        );
        for (const { kind, sub, outcome } of results) {
          if (kind === "wrapped") expect((outcome.value as Report).accessorSub).toBe(sub);
          else expect((outcome.value as RawReport).accessorSub).toBeNull();
          expect((outcome.value as Report).sessionSub).toBe(sub);
        }
      } finally {
        await Promise.all(callers.map(({ session }) => session.close()));
      }
    });
  });

  it("keeps the exchanged tokens of four callers apart", async () => {
    await withServer({ stateless }, async (server) => {
      const callers = await connectAll(server);
      try {
        const results = await Promise.all(
          callers.flatMap(({ sub, session }) =>
            Array.from({ length: 5 }, () =>
              callTool<{ status: number; sub: string }>(session, "delegate").then((outcome) => ({ sub, outcome })),
            ),
          ),
        );
        for (const { sub, outcome } of results) {
          expect(outcome.isError).toBe(false);
          expect(outcome.value).toMatchObject({ status: 200, sub });
        }
      } finally {
        await Promise.all(callers.map(({ session }) => session.close()));
      }
    });
  });

  it("serves one caller after another with no state left behind", async () => {
    await withServer({ stateless }, async (server) => {
      for (const sub of CALLERS) {
        const session = await connect(server, await rig().token(server, { sub }));
        try {
          expect((await callTool<Report>(session, "whoami")).value.accessorSub).toBe(sub);
        } finally {
          await session.close();
        }
      }
    });
  });
});
