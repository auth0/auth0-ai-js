import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_SESSIONS, DEFAULT_TTL_MS, SessionBindings } from "../src/binding.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("SessionBindings", () => {
  it("binds the first subject and accepts it again", () => {
    const bindings = new SessionBindings();
    expect(bindings.accept("s1", "alice")).toBe(true);
    expect(bindings.accept("s1", "alice")).toBe(true);
    expect(bindings.size).toBe(1);
  });

  it("refuses another subject on a bound session id", () => {
    const bindings = new SessionBindings();
    bindings.accept("s1", "alice");
    expect(bindings.accept("s1", "bob")).toBe(false);
    // The refusal does not rebind: alice still owns the id.
    expect(bindings.accept("s1", "alice")).toBe(true);
    expect(bindings.accept("s1", "bob")).toBe(false);
  });

  it("keeps separate session ids apart", () => {
    const bindings = new SessionBindings();
    expect(bindings.accept("s1", "alice")).toBe(true);
    expect(bindings.accept("s2", "bob")).toBe(true);
    expect(bindings.accept("s1", "bob")).toBe(false);
    expect(bindings.accept("s2", "alice")).toBe(false);
  });

  it("forgets an id after the ttl, so the next subject binds it", () => {
    const time = clock();
    const bindings = new SessionBindings({ ttlMs: 1000 }, time.now);
    bindings.accept("s1", "alice");
    time.advance(1001);
    expect(bindings.accept("s1", "bob")).toBe(true);
    expect(bindings.accept("s1", "alice")).toBe(false);
  });

  it("forgets an id exactly when the ttl has passed", () => {
    const time = clock();
    const bindings = new SessionBindings({ ttlMs: 1000 }, time.now);
    bindings.accept("s1", "alice");
    time.advance(1000);
    expect(bindings.accept("s1", "bob")).toBe(true);
  });

  it("still enforces the binding just before the ttl", () => {
    const time = clock();
    const bindings = new SessionBindings({ ttlMs: 1000 }, time.now);
    bindings.accept("s1", "alice");
    time.advance(999);
    expect(bindings.accept("s1", "bob")).toBe(false);
  });

  it("extends the ttl on every use of the id", () => {
    const time = clock();
    const bindings = new SessionBindings({ ttlMs: 1000 }, time.now);
    bindings.accept("s1", "alice");
    for (let i = 0; i < 5; i++) {
      time.advance(800);
      expect(bindings.accept("s1", "alice")).toBe(true);
    }
    expect(bindings.accept("s1", "bob")).toBe(false);
  });

  it("does not extend the ttl when another subject is refused", () => {
    const time = clock();
    const bindings = new SessionBindings({ ttlMs: 1000 }, time.now);
    bindings.accept("s1", "alice");
    time.advance(600);
    expect(bindings.accept("s1", "bob")).toBe(false);
    time.advance(600);
    expect(bindings.accept("s1", "bob")).toBe(true);
  });

  it("evicts the least recently used id beyond the size limit", () => {
    const bindings = new SessionBindings({ maxSessions: 2 });
    bindings.accept("s1", "alice");
    bindings.accept("s2", "bob");
    bindings.accept("s1", "alice");
    bindings.accept("s3", "carol");
    expect(bindings.size).toBe(2);
    // s2 was the least recently used and is gone; s1 and s3 are still bound.
    expect(bindings.accept("s2", "mallory")).toBe(true);
    expect(bindings.accept("s3", "mallory")).toBe(false);
  });

  it("stays within the size limit under many ids", () => {
    const bindings = new SessionBindings({ maxSessions: 50 });
    for (let i = 0; i < 500; i++) bindings.accept(`s${i}`, "alice");
    expect(bindings.size).toBe(50);
  });

  it("has defaults of 10000 ids and one hour", () => {
    expect(DEFAULT_MAX_SESSIONS).toBe(10_000);
    expect(DEFAULT_TTL_MS).toBe(3_600_000);
    const time = clock();
    const bindings = new SessionBindings({}, time.now);
    bindings.accept("s1", "alice");
    time.advance(DEFAULT_TTL_MS - 1);
    expect(bindings.accept("s1", "bob")).toBe(false);
    time.advance(2);
    expect(bindings.accept("s1", "bob")).toBe(true);
  });
});
