import { describe } from "vitest";
import { readE2eSettings } from "./env.js";
import type { E2eEnv } from "./env.js";

/**
 * A suite that talks to the real tenant. When a required setting is missing the whole suite is
 * skipped, and its title names the missing variables (never values), so a run without settings
 * ends green with visible skips instead of a wall of errors. `fn` receives the settings.
 *
 * @param name - Suite title. Put scenario ids in the test titles inside.
 * @param extra - Variables the suite needs on top of the base contract.
 * @param fn - Suite body. Registers hooks and tests as `describe` does.
 */
export function describeLive(name: string, extra: readonly string[], fn: (env: E2eEnv) => void): void {
  const settings = readE2eSettings(extra);
  if (settings.ready) {
    describe(name, () => fn(settings.env));
  } else {
    describe.skip(`${name} (skipped, settings missing: ${settings.missing.join(", ")})`, () => fn(settings.env));
  }
}
