/**
 * Memoized authorization code logins for the organization user. A login drives Universal Login
 * and is the slowest, most rate-limited thing the suite does, so each distinct request is made
 * once per process and shared.
 */
import { loginWithAuthCode } from "./auth-code-login.js";
import type { AuthCodeLoginResult } from "./auth-code-login.js";
import type { E2eEnv } from "./env.js";

const memo = new Map<string, Promise<AuthCodeLoginResult>>();

export interface OrgUserLoginOptions {
  /** Organization id to sign in through. */
  organization: string;
  /** API the token is for. Pass `null` to send only `resource`. Defaults to the MCP API. */
  audience?: string | null;
  /** RFC 8707 resource indicator. */
  resource?: string;
  scope?: string;
}

/** Signs the organization user in through the authorization code flow with PKCE. */
export function loginOrgUser(env: E2eEnv, options: OrgUserLoginOptions): Promise<AuthCodeLoginResult> {
  const audience = options.audience === null ? undefined : (options.audience ?? env.mcpAudience);
  const scope = options.scope ?? `openid ${env.downstreamScope}`;
  const key = JSON.stringify([options.organization, audience ?? null, options.resource ?? null, scope]);
  let login = memo.get(key);
  if (login === undefined) {
    login = loginWithAuthCode({
      domain: env.domain,
      clientId: env.authCodeClientId,
      clientSecret: env.authCodeClientSecret,
      redirectPort: env.authCodeRedirectPort,
      ...(audience !== undefined && { audience }),
      scope,
      organization: options.organization,
      username: env.orgUserUsername,
      password: env.orgUserPassword,
      ...(options.resource !== undefined && { resource: options.resource }),
    });
    memo.set(key, login);
    // A failed login must not be retried by the next caller: that would resubmit the password.
  }
  return login;
}
