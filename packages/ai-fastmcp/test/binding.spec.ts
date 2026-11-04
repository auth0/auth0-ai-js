import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_SESSIONS, DEFAULT_MAX_SESSIONS_PER_SUBJECT, DEFAULT_TTL_MS, SessionBindings } from "../src/binding.js";

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

describe("SessionBindings per subject limit", () => {
  it("has a default of 100 ids per subject", () => {
    expect(DEFAULT_MAX_SESSIONS_PER_SUBJECT).toBe(100);
    const bindings = new SessionBindings();
    for (let i = 0; i < 101; i++) bindings.accept(`s${i}`, "alice");
    expect(bindings.size).toBe(100);
    // s0 was alice's oldest id and is the one that went.
    expect(bindings.accept("s0", "mallory")).toBe(true);
    expect(bindings.accept("s1", "mallory")).toBe(false);
  });

  it("replaces the oldest id of the same subject once the subject is at its limit", () => {
    const bindings = new SessionBindings({ maxSessions: 10, maxSessionsPerSubject: 2 });
    bindings.accept("s1", "alice");
    bindings.accept("s2", "alice");
    bindings.accept("s3", "alice");
    expect(bindings.size).toBe(2);
    expect(bindings.accept("s2", "mallory")).toBe(false);
    expect(bindings.accept("s3", "mallory")).toBe(false);
    expect(bindings.accept("s1", "mallory")).toBe(true);
  });

  it("does not let one subject push out the ids of another", () => {
    const bindings = new SessionBindings({ maxSessions: 4, maxSessionsPerSubject: 2 });
    bindings.accept("a1", "alice");
    for (let i = 0; i < 20; i++) bindings.accept(`junk${i}`, "mallory");
    expect(bindings.accept("a1", "mallory")).toBe(false);
    expect(bindings.accept("a1", "alice")).toBe(true);
  });

  it("counts a used id as recent within its subject", () => {
    const bindings = new SessionBindings({ maxSessions: 10, maxSessionsPerSubject: 2 });
    bindings.accept("s1", "alice");
    bindings.accept("s2", "alice");
    bindings.accept("s1", "alice");
    bindings.accept("s3", "alice");
    expect(bindings.accept("s1", "mallory")).toBe(false);
    expect(bindings.accept("s3", "mallory")).toBe(false);
    expect(bindings.accept("s2", "mallory")).toBe(true);
  });

  it("ignores a per-subject limit above maxSessions, because the whole table is bounded by maxSessions", () => {
    const bindings = new SessionBindings({ maxSessions: 3, maxSessionsPerSubject: 50 });
    for (let i = 0; i < 10; i++) bindings.accept(`s${i}`, "alice");
    expect(bindings.size).toBe(3);
    expect(bindings.accept("s6", "mallory")).toBe(true);
    expect(bindings.accept("s9", "mallory")).toBe(false);
  });

  it("still drops the least recently used id of anyone once the whole map is full", () => {
    const bindings = new SessionBindings({ maxSessions: 3, maxSessionsPerSubject: 2 });
    bindings.accept("a1", "alice");
    bindings.accept("a2", "alice");
    bindings.accept("b1", "bob");
    bindings.accept("c1", "carol");
    expect(bindings.size).toBe(3);
    expect(bindings.accept("a1", "mallory")).toBe(true);
  });

  it("gives the slot back to the previous owner of an expired id that another subject takes", () => {
    const time = clock();
    const bindings = new SessionBindings({ maxSessions: 10, maxSessionsPerSubject: 1, ttlMs: 1000 }, time.now);
    bindings.accept("s1", "alice");
    time.advance(1000);
    expect(bindings.accept("s1", "bob")).toBe(true);
    // alice no longer holds s1, so a new id of hers must not evict bob's.
    expect(bindings.accept("s2", "alice")).toBe(true);
    expect(bindings.accept("s1", "alice")).toBe(false);
    expect(bindings.size).toBe(2);
  });

  it("keeps the newest id when the limit is one", () => {
    const bindings = new SessionBindings({ maxSessions: 5, maxSessionsPerSubject: 1 });
    bindings.accept("s1", "alice");
    bindings.accept("s2", "alice");
    expect(bindings.accept("s2", "mallory")).toBe(false);
    expect(bindings.accept("s1", "mallory")).toBe(true);
  });

  it("keeps no record of a subject whose ids are all gone", () => {
    const bindings = new SessionBindings({ maxSessions: 3, maxSessionsPerSubject: 2 });
    // Twenty subjects with one id each: the table keeps the last three, and so does the subject index.
    for (let i = 0; i < 20; i++) bindings.accept(`s${i}`, `user${i}`);
    expect(bindings.size).toBe(3);
    expect(bindings.subjects).toBe(3);
    // One subject replacing its own ids leaves one record.
    const own = new SessionBindings({ maxSessions: 10, maxSessionsPerSubject: 1 });
    for (let i = 0; i < 5; i++) own.accept(`o${i}`, "alice");
    expect(own.size).toBe(1);
    expect(own.subjects).toBe(1);
  });

  it("counts subjects once however many ids each holds", () => {
    const bindings = new SessionBindings({ maxSessions: 10, maxSessionsPerSubject: 3 });
    bindings.accept("a1", "alice");
    bindings.accept("a2", "alice");
    bindings.accept("b1", "bob");
    expect(bindings.subjects).toBe(2);
    expect(bindings.size).toBe(3);
  });
});
