/** Limits of the in-memory session-to-subject binding. */
export interface SessionBindingOptions {
  /**
   * Most session ids remembered at once. The least recently used id is forgotten first.
   * @defaultValue `10000`
   */
  maxSessions?: number;
  /**
   * How long an id is remembered after its last use, in milliseconds.
   * @defaultValue `3600000` (one hour)
   */
  ttlMs?: number;
}

export const DEFAULT_MAX_SESSIONS = 10_000;
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
 */
export class SessionBindings {
  readonly #entries = new Map<string, Entry>();
  readonly #max: number;
  readonly #ttl: number;
  readonly #now: () => number;

  constructor(options: SessionBindingOptions = {}, now: () => number = Date.now) {
    this.#max = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
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
    // Delete first so the id moves to the end of the insertion order (most recently used).
    this.#entries.delete(sessionId);
    this.#entries.set(sessionId, {
      subject: existing !== undefined && existing.expiresAt > now ? existing.subject : subject,
      expiresAt: now + this.#ttl,
    });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    return true;
  }
}
