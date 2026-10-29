/**
 * Clients that talk to the server under test: the real MCP SDK client over Streamable HTTP, and a
 * raw HTTP probe for the rejection paths, where the SDK client would throw before the test can look.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseChallenge } from "./challenge.js";
import type { ParsedChallenge } from "./challenge.js";

/**
 * The suite starts and stops several servers on one port. A pooled keep-alive connection to the
 * previous server would be reset on first use, so every request asks for a connection of its own.
 */
function withFreshConnection(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  return { ...init, headers };
}

/** A response as the client transport saw it. */
export interface Seen {
  method: string;
  status: number;
  wwwAuthenticate: string | null;
}

export interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** Every response the transport received, in order. */
  seen: Seen[];
  /** The `mcp-session-id` of a stateful server, once the client connected. */
  readonly sessionId: string | undefined;
  close(): Promise<void>;
}

/**
 * Connects a real SDK client. `bearer` is sent as the `Authorization` header on every request.
 * Rejects with the client's own error when the server refuses the connection; the error carries
 * the responses seen so far as `seen`.
 */
export async function connect(
  server: { url: URL },
  bearer?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Session> {
  const seen: Seen[] = [];
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, withFreshConnection(init));
    seen.push({
      method: (input instanceof Request ? input.method : (init?.method ?? "GET")).toUpperCase(),
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate"),
    });
    return response;
  }) as typeof fetch;
  const transport = new StreamableHTTPClientTransport(server.url, {
    fetch: recording,
    requestInit: {
      headers: { ...(bearer !== undefined && { authorization: `Bearer ${bearer}` }), ...extraHeaders },
    },
  });
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  await client.connect(transport).catch(async (error: unknown) => {
    await client.close().catch(() => undefined);
    throw Object.assign(error as Error, { seen });
  });
  return {
    client,
    transport,
    seen,
    get sessionId() {
      return transport.sessionId;
    },
    async close() {
      await client.close();
    },
  };
}

export interface ToolOutcome<T> {
  isError: boolean;
  text: string;
  /** The text parsed as JSON when it is JSON, else the text. */
  value: T;
  meta: Record<string, unknown> | undefined;
}

/** Calls a tool and parses the text as JSON when it is JSON. */
export async function callTool<T = unknown>(
  session: Pick<Session, "client">,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome<T>> {
  const result = (await session.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    _meta?: Record<string, unknown>;
  };
  const text = result.content[0]?.text ?? "";
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Error results carry plain text.
  }
  return { isError: result.isError === true, text, value: value as T, meta: result._meta };
}

/** Names of the tools the server lists for this session. */
export async function listToolNames(session: Pick<Session, "client">): Promise<string[]> {
  const listed = await session.client.listTools();
  return listed.tools.map((tool) => tool.name);
}

export const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1.0.0" } },
};

/** One raw request to the server. */
export async function rawRequest(
  server: { url: URL },
  init: { method?: string; headers?: Record<string, string>; body?: unknown; path?: string } = {},
): Promise<Response> {
  const url = init.path === undefined ? server.url : new URL(init.path, server.url);
  const method = init.method ?? "POST";
  return fetch(
    url,
    withFreshConnection({
      method,
      headers: {
        ...(method === "POST" && { "content-type": "application/json" }),
        accept: "application/json, text/event-stream",
        ...init.headers,
      },
      ...(init.body !== undefined && { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    }),
  );
}

/**
 * The last JSON message in a response body that is either plain JSON or a server-sent event
 * stream. The stream may start with an empty priming event.
 */
export function parseMessage(body: string): unknown {
  const events = [...body.matchAll(/^data: (.*)$/gm)].map((match) => match[1]!).filter((data) => data.trim() !== "");
  return JSON.parse(events.length > 0 ? events[events.length - 1]! : body);
}

/** All response headers as `name: value` lines, for searching them as text. */
export function headersText(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  return lines.join("\n");
}

export interface RawOutcome {
  status: number;
  headers: Headers;
  body: string;
  /** Parsed challenge, or null when the response carried none. */
  challenge: ParsedChallenge | null;
}

/**
 * Sends one MCP `initialize` POST with an arbitrary `Authorization` header value (or none) and
 * reports status, body and challenge.
 */
export async function postInitialize(
  server: { url: URL },
  authorization?: string,
  extraHeaders: Record<string, string> = {},
): Promise<RawOutcome> {
  const response = await rawRequest(server, {
    body: INITIALIZE_BODY,
    headers: { ...(authorization !== undefined && { authorization }), ...extraHeaders },
  });
  const body = await response.text();
  const header = response.headers.get("www-authenticate");
  return {
    status: response.status,
    headers: response.headers,
    body,
    challenge: header === null ? null : parseChallenge(header),
  };
}

/** One raw `tools/call` on an existing session id, with the given token. */
export async function callOnSession(
  server: { url: URL },
  sessionId: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<RawOutcome & { toolText: string | undefined }> {
  const response = await rawRequest(server, {
    body: { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: args } },
    headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
  });
  const body = await response.text();
  let toolText: string | undefined;
  try {
    toolText = (parseMessage(body) as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text;
  } catch {
    toolText = undefined;
  }
  const header = response.headers.get("www-authenticate");
  return {
    status: response.status,
    headers: response.headers,
    body,
    challenge: header === null ? null : parseChallenge(header),
    toolText,
  };
}
