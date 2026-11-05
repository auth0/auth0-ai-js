/**
 * A failed token exchange must be visible on the server and invisible to the client. A wrong client
 * secret and a refused exchange return the fixed tool text and write one log line that carries what
 * the tenant said (its `error` and `error_description`), and never a secret or a token. The
 * `onError` of `createFastMcpAuth` receives the raw error instead of the line.
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callTool,
  connect,
  describeLive,
  expectNoSecrets,
  expectNoTokens,
  firstUser,
  startDownstreamApi,
  startFastMcpServer,
} from "./support/index.js";
import type { DownstreamApi, FastMcpServer, Session } from "./support/index.js";

const MODES = [
  { label: "stateless", stateless: true },
  { label: "stateful", stateless: false },
];

const WRONG_SECRET = "e2e-wrong-client-secret-7c1d";
const LINE_PREFIX = "[ai-fastmcp] Tool failed: ";

describeLive("fastmcp failed exchange visibility", [], (e2e) => {
  const user = firstUser(e2e);
  let downstream: DownstreamApi;
  let userToken: string;

  beforeAll(async () => {
    downstream = await startDownstreamApi({ domain: e2e.domain, audience: e2e.downstreamAudience });
    userToken = await user.token();
  });

  afterAll(async () => {
    await downstream?.close();
  });

  describe.each(MODES)("$label server", ({ stateless }) => {
    let server: FastMcpServer | undefined;
    let session: Session | undefined;
    let error: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      error = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(async () => {
      error.mockRestore();
      await session?.close();
      await server?.stop();
      session = undefined;
      server = undefined;
    });

    function lines(): string[] {
      return error.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith(LINE_PREFIX));
    }

    function expectCleanLine(line: string): void {
      expect(line.length).toBeLessThanOrEqual(300);
      expect(line).not.toMatch(/[\r\n]/);
      expectNoSecrets("the log line", line, [WRONG_SECRET, e2e.oboClientSecret, e2e.loginClientSecret, e2e.password]);
      expectNoTokens("the log line", line, [userToken]);
      expect(line).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    }

    it("E-G-01 pinned-tenant: a wrong client secret gives 401 access_denied; the client sees fixed text, the log has one line, no secret", async () => {
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless, clientSecret: WRONG_SECRET });
      session = await connect(server, userToken);
      const outcome = await callTool(session, "delegate_unobserved", { scope: "work:read" });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe("Tool execution failed.");
      expect(outcome.meta).toEqual({ error: "server_error" });
      expectNoSecrets("the tool result", `${outcome.text}${JSON.stringify(outcome.meta)}`, [WRONG_SECRET, e2e.oboClientSecret]);

      const written = lines();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^\[ai-fastmcp\] Tool failed: \w+/);
      expect(written[0]).toContain(' statusCode=401 auth0_error=access_denied auth0_error_description="Unauthorized"');
      expectCleanLine(written[0]!);
      expect(downstream.calls).toEqual([]);
    });

    it("E-G-01 pinned-tenant: an audience the tenant does not know gives 400 invalid_target; fixed text, one log line with the tenant's error", async () => {
      server = await startFastMcpServer({ env: e2e, downstreamUrl: downstream.url, stateless });
      session = await connect(server, userToken);
      const outcome = await callTool(session, "delegate_unobserved", { audience: "https://unknown.invalid/e2e-no-such-api" });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe("Tool execution failed.");

      const written = lines();
      expect(written).toHaveLength(1);
      expect(written[0]).toContain(' statusCode=400 auth0_error=invalid_target auth0_error_description="Invalid audience specified."');
      expectCleanLine(written[0]!);
    });

    it("E-G-02 the onError of createFastMcpAuth receives the raw error, which holds the tenant's answer, and the line is not written", async () => {
      const received: unknown[] = [];
      server = await startFastMcpServer({
        env: e2e,
        downstreamUrl: downstream.url,
        stateless,
        clientSecret: WRONG_SECRET,
        auth: { onError: (e) => void received.push(e) },
      });
      session = await connect(server, userToken);
      const outcome = await callTool(session, "delegate_unobserved", { scope: "work:read" });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe("Tool execution failed.");
      expect(received).toHaveLength(1);
      const raw = received[0] as Error;
      const body = (raw.cause as { cause?: { error?: unknown; error_description?: unknown } } | undefined)?.cause;
      expect(typeof body?.error).toBe("string");
      expect(lines()).toHaveLength(0);
      expectNoSecrets("the tool result", outcome.text, [WRONG_SECRET, e2e.oboClientSecret]);
    });
  });
});
