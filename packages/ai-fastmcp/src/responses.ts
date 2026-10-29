import { buildWwwAuthenticate } from "@auth0/ai-mcp";
import type { ChallengeErrorCode } from "@auth0/ai-mcp";

const GENERIC_SERVER_ERROR =
  '{"error":"server_error","error_description":"Internal server error."}';

/**
 * Every response `authenticate` throws is built here, so a failure can only ever carry a fixed
 * body. FastMCP sends a thrown `Response` to the client as is; a thrown `Error` it would turn
 * into a 401 that echoes the message.
 */
export function jsonResponse(status: number, body: Record<string, unknown>, headers: Headers = new Headers()): Response {
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

/** The response for a fault of this server. It names nothing about the cause. */
export function genericServerError(): Response {
  return new Response(GENERIC_SERVER_ERROR, {
    status: 500,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export interface ChallengeResponseInit {
  status: number;
  error: ChallengeErrorCode;
  description: string;
  realm: string | undefined;
  metadataUrl: string;
}

/** A Bearer challenge response (RFC 6750) that names the protected resource metadata document. */
export function challengeResponse(init: ChallengeResponseInit): Response {
  const headers = new Headers();
  for (const value of buildWwwAuthenticate({
    schemes: ["Bearer"],
    error: init.error,
    errorDescription: init.description,
    realm: init.realm,
    resourceMetadata: init.metadataUrl,
  })) {
    headers.append("www-authenticate", value);
  }
  return jsonResponse(init.status, { error: init.error, error_description: init.description }, headers);
}

/** The session belongs to another caller. The credential is valid, so there is no challenge. */
export function sessionMismatchResponse(): Response {
  return jsonResponse(403, {
    error: "forbidden",
    error_description: "The session belongs to a different caller.",
  });
}
