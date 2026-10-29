import { InvalidConfigurationError } from '@auth0/auth0-api-js';
import type { McpClientOptions } from './types.js';

/** The environment variables {@link mcpClientOptionsFromEnv} reads, by option name. */
const ENV_NAMES = {
  domain: 'AUTH0_DOMAIN',
  audience: 'AUTH0_AUDIENCE',
  clientId: 'AUTH0_CLIENT_ID',
  clientSecret: 'AUTH0_CLIENT_SECRET',
} as const;

/** A string that holds something other than whitespace, otherwise `undefined`. */
function present(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Reads client options from the environment: `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`,
 * `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`. A variable that is unset, empty or only
 * whitespace is left out of the result. Values are returned as they are, never trimmed,
 * logged or copied into an error.
 *
 * Nothing reads the environment implicitly: {@link createMcpClient} stays strictly
 * explicit. Call this, or pass no client configuration to a handler, to opt in.
 *
 * @param env - The environment to read. Defaults to `process.env`.
 * @returns The options the environment provides. Required ones may be missing.
 */
export function mcpClientOptionsFromEnv(env: Record<string, string | undefined> = process.env): Partial<McpClientOptions> {
  const options: Partial<McpClientOptions> = {};
  for (const name of Object.keys(ENV_NAMES) as Array<keyof typeof ENV_NAMES>) {
    const value = present(env[ENV_NAMES[name]]);
    if (value !== undefined) options[name] = value;
  }
  return options;
}

/**
 * Combines explicit client options with the environment. Explicit values win. For
 * `domain`, `audience`, `clientId` and `clientSecret` a blank explicit string counts as
 * unset, so the environment fills it; every other option is taken from `explicit` as is.
 *
 * @param explicit - Options given in code.
 * @param env - The environment to read. Defaults to `process.env`.
 * @returns Complete client options.
 * @throws {InvalidConfigurationError} When `domain` or `audience` is missing from both
 * sources. The message names the option and its environment variable, never a value.
 */
export function resolveMcpClientOptions(
  explicit: Partial<McpClientOptions> = {},
  env: Record<string, string | undefined> = process.env
): McpClientOptions {
  const fromEnv = mcpClientOptionsFromEnv(env);
  const merged: Partial<McpClientOptions> = { ...fromEnv, ...explicit };
  for (const name of Object.keys(ENV_NAMES) as Array<keyof typeof ENV_NAMES>) {
    const value = present(explicit[name]) ?? fromEnv[name];
    if (value !== undefined) merged[name] = value;
    else if (explicit[name] !== undefined) delete merged[name];
  }
  for (const name of ['domain', 'audience'] as const) {
    if (merged[name] === undefined) {
      throw new InvalidConfigurationError(
        `Missing MCP client option "${name}": pass it explicitly or set the ${ENV_NAMES[name]} environment variable.`
      );
    }
  }
  return merged as McpClientOptions;
}
