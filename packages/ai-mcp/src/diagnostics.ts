/**
 * Writes one diagnostic line to `console.warn`, prefixed so it can be found in a log.
 *
 * Callers pass fixed text only. A message must never contain a token, a claim value, a
 * storage key or text taken from an error, because log output is often shared more widely
 * than the process that wrote it.
 */
export function warn(message: string): void {
  console.warn(`[auth0-ai-mcp] ${message}`);
}
