/** Clients that talk to the server under test: the real MCP SDK client and a raw HTTP probe. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseChallenge } from "./challenge.js";
import type { ParsedChallenge } from "./challenge.js";

export interface ConnectedClient {
  client: Client;
  close(): Promise<void>;
}

/** Connects a real SDK client over `StreamableHTTPClientTransport` with a bearer token. */
export async function connectMcpClient(url: URL, accessToken?: string): Promise<ConnectedClient> {
  const transport = new StreamableHTTPClientTransport(url, {
    ...(accessToken !== undefined && { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }),
  });
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** Result of a tool call with the JSON text payload parsed. */
export async function callToolJson<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; value: T }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = result.content[0]?.text ?? "";
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Error results carry plain text.
  }
  return { isError: result.isError === true, value: value as T };
}

export interface RawResponse {
  status: number;
  /** Raw `WWW-Authenticate` header, or null. */
  wwwAuthenticate: string | null;
  /** Parsed challenge, or null when the response carried none. */
  challenge: ParsedChallenge | null;
}

/**
 * Sends one MCP `initialize` POST with an arbitrary `Authorization` header value (or none) and
 * reports status and challenge. Used for the rejection paths, where the SDK client would throw.
 */
export async function postInitialize(url: URL, authorization?: string): Promise<RawResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization !== undefined && { authorization }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e-probe", version: "1.0.0" },
      },
    }),
  });
  await response.arrayBuffer();
  const header = response.headers.get("www-authenticate");
  return {
    status: response.status,
    wwwAuthenticate: header,
    challenge: header === null ? null : parseChallenge(header),
  };
}
