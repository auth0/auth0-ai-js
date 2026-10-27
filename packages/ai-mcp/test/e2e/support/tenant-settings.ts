/**
 * Read-only access to the tenant settings, used only by `client-prerequisites.e2e.spec.ts`.
 * The only Management API call is a GET; any other method throws before a request is made.
 * Tokens are never logged or included in errors.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** Accepts only a bare host name, so the client secret and tokens cannot be sent to another host. */
function assertTenantDomain(domain: string): void {
  if (!HOSTNAME.test(domain)) {
    throw new Error(
      "Tenant domain must be a bare host name (letters, digits, dots and hyphens; no scheme, path, port or credentials).",
    );
  }
}

/** Builds the Management API URL and checks it after normalization. */
function managementUrl(domain: string, path: string): URL {
  const fail = (): never => {
    throw new Error("Management API path must start with /api/v2/ and stay inside it.");
  };
  if (!path.startsWith("/api/v2/") || path.includes("..") || path.includes("\\") || /%(2e|2f|5c)/i.test(path)) {
    return fail();
  }
  const base = `https://${domain}`;
  const url = new URL(path, base);
  if (url.origin !== base || !url.pathname.startsWith("/api/v2/")) return fail();
  return url;
}

export interface ManagementGetOptions {
  domain: string;
  token: string;
  /** Must start with `/api/v2/`. */
  path: string;
  /** Defaults to GET. Anything else throws before a request is made. */
  method?: string;
}

export interface ManagementGetResult {
  status: number;
  /** Parsed JSON body, or an empty object when the body was not JSON. */
  body: unknown;
}

/** Management API GET. Throws for any other method (including lowercase), a bad domain, or a path outside `/api/v2/`. */
export async function managementGet(fetchImpl: typeof fetch, options: ManagementGetOptions): Promise<ManagementGetResult> {
  const method = options.method ?? "GET";
  if (method !== "GET") {
    throw new Error(`Management API access in the e2e suite is GET only; refused ${method}.`);
  }
  assertTenantDomain(options.domain);
  const url = managementUrl(options.domain, options.path);
  const response = await fetchImpl(url.href, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
  });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch {
    // not JSON: keep the empty object
  }
  return { status: response.status, body };
}

/** Gets a Management API token with the client credentials grant (token endpoint only). */
export async function mintManagementToken(
  fetchImpl: typeof fetch,
  options: { domain: string; clientId: string; clientSecret: string },
): Promise<string> {
  assertTenantDomain(options.domain);
  const response = await fetchImpl(`https://${options.domain}/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      audience: `https://${options.domain}/api/v2/`,
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
  if (response.status !== 200 || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : "unknown";
    throw new Error(`Could not get a Management API token (HTTP ${response.status}, error ${code}).`);
  }
  return body.access_token;
}

export interface ClientPrerequisites {
  cimd: "on" | "off" | "unknown";
  profile: string;
  /** One message per failing setting; empty when both are correct. */
  failures: string[];
}

const SCOPE_NOTE =
  "These two settings matter only for real third-party MCP clients such as Claude Code. " +
  "The password-realm flow the other e2e specs use does not need them, so this is not an SDK regression.";

/** Checks the two tenant settings a real third-party MCP client needs. */
export function evaluateClientPrerequisites(settings: unknown): ClientPrerequisites {
  const record = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>) : {};
  const rawCimd = record["client_id_metadata_document_supported"];
  const rawProfile = record["resource_parameter_profile"];
  const cimd = rawCimd === true ? "on" : rawCimd === false ? "off" : "unknown";
  const profile = typeof rawProfile === "string" ? rawProfile : "unknown";
  const failures: string[] = [];

  if (cimd === "off") {
    failures.push(
      `Client ID Metadata Document Registration is off. Turn on Client ID Metadata Document Registration in Settings > Advanced of the Auth0 Dashboard. ${SCOPE_NOTE}`,
    );
  } else if (cimd === "unknown") {
    failures.push(
      `Client ID Metadata Document Registration could not be read (client_id_metadata_document_supported is missing or not a boolean, or the credential cannot read tenant settings). Check it by hand in Settings > Advanced; it must be on. ${SCOPE_NOTE}`,
    );
  }
  if (profile === "unknown") {
    failures.push(
      `Resource Parameter Compatibility Profile could not be read (resource_parameter_profile is missing or not a string, or the credential cannot read tenant settings). Check it by hand in Settings > Advanced; it must be compatibility. ${SCOPE_NOTE}`,
    );
  } else if (profile !== "compatibility") {
    failures.push(
      `Resource Parameter Compatibility Profile is currently ${profile}. Set Resource Parameter Compatibility Profile to compatibility in Settings > Advanced of the Auth0 Dashboard. ${SCOPE_NOTE}`,
    );
  }
  return { cimd, profile, failures };
}
