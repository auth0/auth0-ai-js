import { describe, expect, it, vi } from "vitest";
import { safely } from "../src/hooks.js";

describe("safely", () => {
  it("hands the error to the hook", () => {
    const hook = vi.fn();
    const error = new Error("boom");
    safely(hook, error);
    expect(hook).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("does nothing without a hook", () => {
    expect(() => safely(undefined, new Error("boom"))).not.toThrow();
  });

  it("ignores a hook that throws", () => {
    expect(() =>
      safely(() => {
        throw new Error("hook failed");
      }, new Error("boom")),
    ).not.toThrow();
  });

  it("ignores a hook that returns a rejected promise, so no unhandled rejection follows", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      safely(() => Promise.reject(new Error("hook failed")) as unknown as void, new Error("boom"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("accepts a hook that returns a resolved promise", async () => {
    const hook = vi.fn(async () => {});
    safely(hook as unknown as (error: unknown) => void, new Error("boom"));
    await Promise.resolve();
    expect(hook).toHaveBeenCalledOnce();
  });
});
