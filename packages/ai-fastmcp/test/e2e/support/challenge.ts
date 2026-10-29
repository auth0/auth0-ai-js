/** Parsing helper for `WWW-Authenticate` challenges. */

export interface ParsedChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parses one `Scheme a="b", c="d"` challenge. Throws when the header is missing or holds anything
 * else, so a malformed challenge fails the test instead of passing as an empty one.
 */
export function parseChallenge(header: string | null): ParsedChallenge {
  if (header === null) throw new Error("The response carried no WWW-Authenticate header.");
  const match = /^([A-Za-z]+)(?: (.*))?$/.exec(header);
  if (match === null) throw new Error("The WWW-Authenticate header is not a single challenge.");
  const params: Record<string, string> = {};
  const rest = match[2] ?? "";
  const pattern = /([a-z_]+)="([^"]*)"(?:, |$)/g;
  let consumed = 0;
  for (let found = pattern.exec(rest); found !== null; found = pattern.exec(rest)) {
    params[found[1]!] = found[2]!;
    consumed = pattern.lastIndex;
  }
  if (consumed !== rest.length) throw new Error("The WWW-Authenticate parameters are not well formed.");
  return { scheme: match[1]!, params };
}
