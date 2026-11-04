/** Limits of the in-memory session-to-subject binding. */
export interface SessionBindingOptions {
  /**
   * Most session ids remembered at once. The least recently used id is forgotten first.
   * @defaultValue `10000`
   */
  maxSessions?: number;
  /**
   * Most session ids one subject can have remembered at once. When a subject reaches it, the oldest
   * id of that same subject is forgotten, so one caller cannot push out the ids of others. It
   * cannot exceed `maxSessions`. Raise it for a subject that legitimately holds many sessions, such
   * as a gateway that uses one client credentials token.
   * @defaultValue `100`
   */
  maxSessionsPerSubject?: number;
  /**
   * How long an id is remembered after its last use, in milliseconds.
   * @defaultValue `3600000` (one hour)
   */
  ttlMs?: number;
}

export const DEFAULT_MAX_SESSIONS = 10_000;
export const DEFAULT_MAX_SESSIONS_PER_SUBJECT = 100;
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Longest session id accepted. FastMCP issues UUIDs; anything much longer is not one of its ids. */
export const MAX_SESSION_ID_LENGTH = 256;

interface Entry {
  subject: string;
  expiresAt: number;
}

/**
 * Remembers which subject first used each session id and refuses any other subject on it.
 *
 * FastMCP accepts a second valid token on another caller's session id and runs the call as the
 * new caller; nothing ties a session id to the subject that created it. This binding closes that
 * gap for one process. It is bounded in size and time, so a restart or an eviction forgets a
 * binding, and it does not span several server processes.
 *
 * The check runs before FastMCP looks the id up, so the map also sees ids FastMCP never issued.
 * Each subject therefore holds at most `maxSessionsPerSubject` ids and replaces its own oldest one
 * beyond that; only when the whole map is full does the least recently used id of anyone go.
 */
export class SessionBindings {
  readonly #entries = new Map<string, Entry>();
  readonly #bySubject = new Map<string, Set<string>>();
  readonly #max: number;
  readonly #maxPerSubject: number;
  readonly #ttl: number;
  readonly #now: () => number;

  constructor(options: SessionBindingOptions = {}, now: () => number = Date.now) {
    this.#max = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#maxPerSubject = Math.min(options.maxSessionsPerSubject ?? DEFAULT_MAX_SESSIONS_PER_SUBJECT, this.#max);
    this.#ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = now;
  }

  /** Number of ids currently remembered, expired ones included until they are next touched. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Records the subject on first sight of a session id and checks it afterwards.
   *
   * @returns `true` when the subject owns the id or the id is new, `false` when another subject
   * owns it.
   */
  accept(sessionId: string, subject: string): boolean {
    const now = this.#now();
    const existing = this.#entries.get(sessionId);
    if (existing !== undefined && existing.expiresAt > now && existing.subject !== subject) {
      return false;
    }
    // Forget the old record first so the id moves to the end of the insertion order (most recently used).
    if (existing !== undefined) this.#forget(sessionId, existing.subject);
    let held = this.#bySubject.get(subject);
    while (held !== undefined && held.size >= this.#maxPerSubject) {
      const oldest = held.values().next();
      if (oldest.done) break;
      this.#forget(oldest.value, subject);
      held = this.#bySubject.get(subject);
    }
    this.#entries.set(sessionId, { subject, expiresAt: now + this.#ttl });
    const owned = this.#bySubject.get(subject) ?? new Set<string>();
    owned.add(sessionId);
    this.#bySubject.set(subject, owned);
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.entries().next();
      if (oldest.done) break;
      this.#forget(oldest.value[0], oldest.value[1].subject);
    }
    return true;
  }

  #forget(sessionId: string, subject: string): void {
    this.#entries.delete(sessionId);
    const owned = this.#bySubject.get(subject);
    owned?.delete(sessionId);
    if (owned?.size === 0) this.#bySubject.delete(subject);
  }
}
