/** The longest log line this package writes. */
const MAX_LINE_LENGTH = 300;
const MAX_FIELD_LENGTH = 80;
const MAX_CAUSE_DEPTH = 8;

function clean(value: string, max: number): string {
  // Control characters and line separators out, so an error cannot forge a second log line.
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 3))}...` : flat;
}

function field(value: unknown, max = MAX_FIELD_LENGTH): string | undefined {
  if (typeof value === "string" && value !== "") return clean(value, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The first `error` string and the `error_description` string found on the cause chain. */
function auth0Details(error: unknown): { error?: string; description?: string } {
  const seen = new Set<unknown>();
  let node: unknown = error;
  const details: { error?: string; description?: string } = {};
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && typeof node === "object" && node !== null; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const record = node as { error?: unknown; error_description?: unknown; cause?: unknown };
    if (details.error === undefined && typeof record.error === "string") {
      details.error = record.error;
      if (typeof record.error_description === "string") details.description = record.error_description;
    }
    node = record.cause;
  }
  return details;
}

/**
 * One log line for a tool failure: the error name, `code` and `statusCode`, and Auth0's `error` and
 * `error_description` when the cause chain holds them. It never reads `message`, headers, a request
 * body or a token, and it is at most 300 characters on a single line.
 */
export function describeFailure(error: unknown): string {
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
  };
  const name = error instanceof Error ? (field(record.name) ?? "Error") : typeof error;
  const parts = [`[ai-fastmcp] Tool failed: ${name}`];
  const code = field(record.code);
  if (code !== undefined) parts.push(`code=${code}`);
  const status = field(record.statusCode);
  if (status !== undefined) parts.push(`statusCode=${status}`);
  const details = auth0Details(error);
  const auth0Error = field(details.error);
  if (auth0Error !== undefined) parts.push(`auth0_error=${auth0Error}`);
  const description = field(details.description, MAX_LINE_LENGTH);
  if (description !== undefined) parts.push(`auth0_error_description="${description}"`);
  return clean(parts.join(" "), MAX_LINE_LENGTH);
}
