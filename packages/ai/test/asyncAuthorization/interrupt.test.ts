import { describe, expect, it } from "vitest";

import {
  AsyncAuthorizationInterrupt,
  AuthorizationPendingInterrupt,
  AuthorizationPollingInterrupt,
} from "../../src/interrupts/AsyncAuthorizationInterrupt";

describe("Async Authorization Interrupts", () => {
  it("isInterrupt should properly work", () => {
    const interrupt = new AuthorizationPendingInterrupt("test", {
      id: "123",
      requestedAt: Date.now(),
      expiresIn: Date.now() + 1000,
      interval: 300,
    });
    expect(AsyncAuthorizationInterrupt.isInterrupt(interrupt)).toBe(true);
    expect(AuthorizationPendingInterrupt.isInterrupt(interrupt)).toBe(true);
    expect(AuthorizationPollingInterrupt.isInterrupt(interrupt)).toBe(false);
  });
});
