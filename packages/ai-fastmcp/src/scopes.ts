import { InvalidConfigurationError } from "@auth0/ai-mcp";

/**
 * Turns a scope requirement into a flat list: each entry is split on whitespace, repeats are
 * dropped, and `undefined`, `null` or an empty list mean no requirement. This is the rule
 * `@auth0/ai-mcp` applies to `requiredScopes`, applied here at construction so a mistake fails
 * when the server is built and no request ever reaches the check that would throw.
 *
 * @param required - One scope, a space-delimited string of scopes, or a list of such strings.
 * @param option - The option name for the error message.
 * @throws {InvalidConfigurationError} When `required` is neither a string nor a list, or an entry
 * is blank or not a string. A blank entry would otherwise read as "no requirement" and leave the
 * route open.
 */
export function normalizeRequiredScopes(required: unknown, option: string): string[] {
  if (required === undefined || required === null) return [];
  const list: unknown = typeof required === "string" ? [required] : required;
  if (!Array.isArray(list)) {
    throw new InvalidConfigurationError(`Invalid configuration: "${option}" must be a list of scope strings.`);
  }
  const scopes = list.flatMap((entry: unknown) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new InvalidConfigurationError(
        `Invalid configuration: every entry of "${option}" must be a non-blank string.`,
      );
    }
    return entry.split(/\s+/).filter((scope) => scope.length > 0);
  });
  return [...new Set(scopes)];
}
