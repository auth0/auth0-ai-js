/**
 * Glue between this package and the MCP TypeScript SDK v2
 * (`@modelcontextprotocol/server`).
 *
 * This module is the only one that imports the SDK. The SDK is an optional peer
 * dependency, so the module is published as its own entry point and nothing else
 * in the package imports it. Only the v2 packages are supported: the v1 package
 * (`@modelcontextprotocol/sdk`) uses different class and error types, and objects
 * from the two lines must not be mixed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthError } from '@auth0/auth0-api-js';
import {
  OAuthError,
  OAuthErrorCode,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { AuthInfo as SdkAuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { McpClient } from './client.js';
import { createMcpHandler, resolveHandlerClient, resolveHandlerEndpoints } from './handler.js';
import type { AuthInfo, McpHandlerBaseOptions, McpHandlerClientConfig, McpHandlerOptions } from './handler.js';

/**
 * The part of the SDK's `McpServer` (or low-level `Server`) this module uses.
 * Any object with `connect` and `close` fits.
 */
export interface McpServerLike {
  connect(transport: WebStandardStreamableHTTPServerTransport): Promise<void>;
  close(): Promise<void>;
}

/**
 * Options for {@link createMcpSdkHandler}: the handler options without `handler`, plus
 * `createServer`. The client is configured through `client`, inline client options or the
 * environment; see {@link McpHandlerClientConfig}.
 */
export type McpSdkHandlerOptions = McpHandlerClientConfig &
  Omit<McpHandlerBaseOptions, 'handler'> & {
    /**
     * Creates the server that answers one request. It is called once per request
     * and the server is closed when the request ends, because the transport runs
     * in stateless mode and the SDK does not allow a stateless transport to be
     * shared between requests. Register tools inside this function; keep expensive
     * setup outside of it.
     */
    createServer: () => McpServerLike | Promise<McpServerLike>;
  };

/**
 * Creates a function that authenticates MCP HTTP requests with
 * {@link createMcpHandler} and serves them with the SDK's web standard
 * Streamable HTTP transport. It takes a standard `Request` and returns a `Response`.
 *
 * The verified caller reaches your tools in two ways: as `ctx.http.authInfo` in every
 * tool callback (the SDK's own mechanism), and through the request context, so
 * `getCallerMcpClient()`, `getCallerPrincipal()` and `withRequiredScopes()` work
 * inside tools.
 *
 * `AuthInfo.clientId` is `''` when the token carries no `client_id` or `azp`.
 * `AuthInfo.token` is always `''`: the bearer is deliberately withheld, so tools
 * should call downstream APIs through the request-scoped client. The SDK
 * still exposes the original request to tool callbacks as `ctx.http.req`, so
 * the `Authorization` header is reachable there.
 *
 * Mode: stateless and JSON responses, using the SDK's low-level web standard
 * transport. The SDK's own `createMcpHandler` is not used because it answers
 * with an event stream. The server is closed as soon as `handleRequest` returns,
 * which is only valid for JSON response mode (a streamed response would be cut
 * off), so this function does not offer streaming. Each POST is answered with one JSON body and no session id is
 * issued, so any instance can serve any request.
 * Server-to-client notifications and standalone event streams (GET) are not
 * offered. If you need sessions or streaming, use {@link createMcpHandler} and
 * manage the transport yourself.
 *
 * Failures that happen before the server runs (no credential, bad token, missing
 * server-wide scope) follow the challenge rules of {@link createMcpHandler}.
 * A tool that needs a scope only for itself should use `withRequiredScopes`,
 * which answers with an `isError` tool result and HTTP 200. The same holds for a
 * downscoped token exchange inside a tool: the MCP SDK catches errors thrown by
 * tools, so on this path the caller sees a sanitized tool result with
 * `isError: true` and HTTP 200. A 403 `insufficient_scope` response applies only
 * when such an error escapes a custom {@link createMcpHandler} handler.
 *
 * Only POST is served on the MCP endpoint. After authentication, any other method
 * gets 405 with `Allow: POST`.
 *
 * @param options - Handler options plus {@link McpSdkHandlerOptions.createServer}.
 * @returns A function from `Request` to `Response`.
 */
export function createMcpSdkHandler(
  options: McpSdkHandlerOptions,
): (request: Request) => Promise<Response> {
  const { createServer, ...handlerOptions } = options;
  return createMcpHandler({
    ...handlerOptions,
    handler: async (request: Request, authInfo: AuthInfo): Promise<Response> => {
      // Only POST is served. This runs after authentication (the metadata route is
      // answered before it), so an unauthenticated GET gets the usual 401 challenge.
      if (request.method !== 'POST') {
        return new Response(null, { status: 405, headers: { allow: 'POST' } });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = await createServer();
      try {
        await server.connect(transport);
        return await transport.handleRequest(request, { authInfo });
      } finally {
        await server.close().catch(() => undefined);
      }
    },
  } as McpHandlerOptions);
}

/** Options for {@link toNodeHandler}. */
export interface NodeHandlerOptions {
  /**
   * Public identifier of the server. Its origin is used to rebuild the absolute
   * request URL, so the `Host` header of the incoming request is never trusted
   * (DPoP checks the URL the client used).
   */
  resource: string;
  /** Largest request body accepted, in bytes. Defaults to 1 MiB. Larger bodies get a 413. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function genericResponse(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
  close = false,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Drop anything an earlier step set (for example headers of a failed upstream response).
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.statusCode = status;
  if (close) res.setHeader('connection', 'close');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ error, error_description: description }));
}

class BodyTooLargeError extends Error {}
class MalformedRequestError extends Error {}

const VALID_PATH = /^\/(?![/\\])[^\s]*$/;

function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    if (!/^\d{1,15}$/.test(declared)) return Promise.reject(new MalformedRequestError());
    if (Number(declared) > limit) return Promise.reject(new BodyTooLargeError());
  }
  // Event based on purpose: leaving a `for await` loop early destroys the socket,
  // which would drop the 413 before it is delivered.
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Uint8Array | string) => {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      size += bytes.byteLength;
      if (size > limit) {
        cleanup();
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      if (chunks.length === 0) return resolve(undefined);
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(body);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Request closed.'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * Adapts a standard `Request` to `Response` handler, such as the one returned
 * by {@link createMcpHandler} or {@link createMcpSdkHandler}, to Node's `http`
 * request listener signature. The result mounts on `http.createServer`, Express
 * (`app.all('/mcp', handler)`) and anything else that passes
 * `IncomingMessage` and `ServerResponse`.
 *
 * All authentication stays in the web handler; this function only converts
 * messages. Headers, including `Authorization` and `DPoP`, are passed through
 * unchanged. The body is read up to `maxBodyBytes`; a malformed `Content-Length`
 * or a path that does not start with a single `/` gets 400, an oversized body 413
 * (the connection is closed). Mount it before body-parsing middleware; if a parser
 * already consumed the stream, the parsed `req.body` (string, Buffer or object) is
 * re-serialized (objects as JSON) with the same size limit, so the bytes the web
 * handler sees can differ from the original. An empty `{}` with no
 * non-zero `Content-Length` or `Transfer-Encoding` is the parser default and counts as no body. Any other error becomes a generic 500.
 *
 * @param handle - The web handler to adapt.
 * @param options - Public resource identifier and body limit.
 * @returns A function that writes the response to `res` and never rejects.
 */
export function toNodeHandler(
  handle: (request: Request) => Promise<Response>,
  options: NodeHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const origin = new URL(options.resource).origin;
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async function listener(req, res) {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.append(name, value);
        }
      }
      const method = req.method ?? 'GET';
      const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
      // Only a single-slash path keeps the origin fixed; "//host" would be read as another authority.
      if (!VALID_PATH.test(path)) throw new MalformedRequestError();
      let body: BodyInit | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const parsed = (req as IncomingMessage & { body?: unknown }).body;
        const framed =
          (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
          req.headers['transfer-encoding'] !== undefined;
        const emptyParserDefault =
          !framed &&
          typeof parsed === 'object' &&
          parsed !== null &&
          !(parsed instanceof Uint8Array) &&
          Object.keys(parsed).length === 0;
        if (parsed !== undefined && !emptyParserDefault) {
          const bytes =
            parsed instanceof Uint8Array
              ? parsed
              : new TextEncoder().encode(typeof parsed === 'string' ? parsed : (JSON.stringify(parsed) ?? ''));
          if (bytes.byteLength > limit) throw new BodyTooLargeError();
          body = bytes as unknown as BodyInit;
          headers.delete('content-length');
        } else {
          const bytes = await readBody(req, limit);
          if (bytes !== undefined) body = bytes as unknown as BodyInit;
        }
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      const response = await handle(
        new Request(origin + path, { method, headers, body, signal: controller.signal }),
      );
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.appendHeader(name, value));
      if (response.body === null) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      // A stalled stream must not outlive a client that went away.
      const onClose = () => void reader.cancel().catch(() => undefined);
      res.once('close', onClose);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.destroyed) break;
          if (!res.write(value)) {
            await new Promise<void>((resolve) => {
              const finish = () => {
                res.off('drain', finish);
                res.off('close', finish);
                resolve();
              };
              res.once('drain', finish);
              res.once('close', finish);
            });
          }
        }
        res.end();
      } finally {
        res.off('close', onClose);
        await reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        res.once('finish', () => req.destroy());
        genericResponse(res, 413, 'invalid_request', 'The request body is too large.', true);
        return;
      }
      if (error instanceof MalformedRequestError) {
        genericResponse(res, 400, 'invalid_request', 'The request is malformed.', true);
        return;
      }
      genericResponse(res, 500, 'server_error', 'Internal server error.');
    }
  };
}

/**
 * Convenience for {@link createMcpSdkHandler} followed by {@link toNodeHandler}.
 *
 * `resource` and `authorizationServers` are optional here: they default to the
 * client's audience and to `https://<domain>/` (see {@link McpHandlerOptions}); an
 * explicit `resource` must equal the client audience. The client is configured through
 * `client`, inline client options or the environment, like in {@link createMcpHandler}.
 * The resolved resource is also the public origin the Node adapter uses to
 * rebuild request URLs.
 *
 * @param options - Handler options plus an optional body limit.
 * @returns A Node request listener.
 * @throws {InvalidConfigurationError} When a default is needed and the client
 * does not provide a usable audience or domain, when `client` is combined with inline
 * client options, or when a required client value is missing from the options and the
 * environment.
 */
export function createNodeMcpHandler(
  options: McpSdkHandlerOptions & Pick<NodeHandlerOptions, 'maxBodyBytes'>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { maxBodyBytes, ...handlerOptions } = options;
  // Resolve the client once so the handler and the endpoint defaults use the same one.
  const { client, rest } = resolveHandlerClient(handlerOptions);
  const endpoints = resolveHandlerEndpoints(client, rest);
  return toNodeHandler(createMcpSdkHandler({ ...rest, client, ...endpoints } as McpSdkHandlerOptions), {
    resource: endpoints.resource,
    maxBodyBytes,
  });
}

/**
 * Adapts an {@link McpClient} to the SDK's `OAuthTokenVerifier`, for use with the
 * SDK's `requireBearerAuth` (the Express middleware in `@modelcontextprotocol/express`
 * or the web standard gate in `@modelcontextprotocol/server`).
 *
 * Prefer {@link createMcpHandler} or {@link createMcpSdkHandler}. This shim
 * INHERITS THE SDK MIDDLEWARE'S CHALLENGE BEHAVIOUR, which does not meet this
 * package's challenge rules: it answers a missing credential with
 * `error="invalid_token"` (RFC 6750 section 3.1 says to send no error value),
 * echoes the SDK's own messages in `error_description`, lists the configured
 * scopes rather than only the missing ones, and does not know DPoP. Here, Bearer
 * is the only scheme and a DPoP-bound token fails verification.
 *
 * What you lose compared with the handler: `requireBearerAuth` does not run
 * this package's request context. Inside your routes `getRequestContext()`,
 * `getCallerPrincipal()` and `getCallerMcpClient()` return `undefined`, and no
 * request-scoped client exists. To get them back, call `client.verifyAccessToken`
 * yourself in a wrapper and use `runWithRequestContext`, or switch to the handler.
 *
 * Errors are mapped with generic messages: any failed verification becomes the
 * SDK's `OAuthError` with code `invalid_token`, a 403 from the core becomes an
 * `OAuthError` with code `insufficient_scope`, and everything else is rethrown so
 * the middleware answers 500. The v2 middleware only maps `OAuthError` to 401 and
 * 403; any other error type (including the v1 SDK's error classes) would end as 500.
 *
 * @param client - The client that verifies tokens.
 * @returns A verifier for `requireBearerAuth({ verifier })`.
 */
export function asTokenVerifier(client: McpClient): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<SdkAuthInfo> {
      let caller;
      try {
        caller = await client.verifyAccessToken({ accessToken: token, scheme: 'bearer' });
      } catch (error) {
        if (error instanceof AuthError) {
          if (error.statusCode === 403) {
            throw new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope.');
          }
          if (error.statusCode === undefined || error.statusCode < 500) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token.');
          }
        }
        throw error;
      }
      const principal = caller.principal;
      return {
        token: '',
        clientId: principal.clientId ?? '',
        scopes: [...principal.scopes],
        expiresAt: principal.expiresAt,
        extra: {
          sub: principal.sub,
          ...(principal.orgId !== null && { orgId: principal.orgId }),
        },
      };
    },
  };
}
