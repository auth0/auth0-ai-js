/** Parsing helpers for `WWW-Authenticate` challenges. */

export interface ParsedChallenge {
  scheme: string;
  params: Record<string, string>;
}

/** Parses a single challenge such as `Bearer realm="x", error="invalid_token"`. */
export function parseChallenge(header: string | null): ParsedChallenge {
  if (header === null) throw new Error("Response carried no WWW-Authenticate header.");
  const space = header.indexOf(" ");
  const scheme = space === -1 ? header : header.slice(0, space);
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)="((?:[^"\\]|\\.)*)"/g)) {
    params[match[1]!] = match[2]!.replace(/\\(.)/g, "$1");
  }
  return { scheme, params };
}
