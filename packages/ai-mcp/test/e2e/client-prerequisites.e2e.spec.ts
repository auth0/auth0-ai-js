/**
 * Read-only check of the two tenant settings that real third-party MCP clients (for example
 * Claude Code) need: Client ID Metadata Document registration on, and Resource Parameter
 * Compatibility Profile set to compatibility. The other specs use the password-realm flow and do
 * not need them, so a failure here is a tenant setup problem, not an SDK regression.
 *
 * Skipped when no Management API credential is set at all: AUTH0_E2E_MGMT_TOKEN, or
 * AUTH0_E2E_MGMT_CLIENT_ID and AUTH0_E2E_MGMT_CLIENT_SECRET. With the credentials half set (only
 * one of the id and secret pair, or no domain) the spec fails and names the missing variables, so
 * a typo never skips it silently.
 * Only GET requests are made. Nothing in the tenant is changed.
 */
import { describe, expect, it } from "vitest";
import { evaluateClientPrerequisites, managementGet, mintManagementToken } from "./support/index.js";

const token = process.env["AUTH0_E2E_MGMT_TOKEN"] ?? "";
const clientId = process.env["AUTH0_E2E_MGMT_CLIENT_ID"] ?? "";
const clientSecret = process.env["AUTH0_E2E_MGMT_CLIENT_SECRET"] ?? "";
const domain = process.env["AUTH0_E2E_DOMAIN"] ?? "";
const anyCredential = token !== "" || clientId !== "" || clientSecret !== "";
const hasCredentials = domain !== "" && (token !== "" || (clientId !== "" && clientSecret !== ""));

/** Names (never values) of the variables a half-set configuration still needs. */
function missingManagementVariables(): string[] {
  const missing: string[] = [];
  if (domain === "") missing.push("AUTH0_E2E_DOMAIN");
  if (token === "") {
    if (clientId === "") missing.push("AUTH0_E2E_MGMT_CLIENT_ID");
    if (clientSecret === "") missing.push("AUTH0_E2E_MGMT_CLIENT_SECRET");
  }
  return missing;
}

describe.runIf(anyCredential && !hasCredentials)("tenant prerequisites credentials", () => {
  it("are complete when any Management API credential is set", () => {
    expect(missingManagementVariables(), "Management API credentials are only partly set").toEqual([]);
  });
});

describe.skipIf(!hasCredentials)("tenant prerequisites for real third-party MCP clients (read-only)", () => {
  it("has Client ID Metadata Document registration on and the compatibility resource profile", async () => {
    const bearer = token !== "" ? token : await mintManagementToken(fetch, { domain, clientId, clientSecret });
    const { status, body } = await managementGet(fetch, { domain, token: bearer, path: "/api/v2/tenants/settings" });
    expect(status, "Reading tenant settings failed; the credential needs permission to read tenant settings.").toBe(200);
    const result = evaluateClientPrerequisites(body);
    expect(result.failures, result.failures.join("\n")).toEqual([]);
  });
});
