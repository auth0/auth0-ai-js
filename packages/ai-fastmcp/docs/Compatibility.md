# Compatibility

This page lists what the test suites of this package ran against, and nothing beyond that. A version or revision that is not listed here has not been tried.

## FastMCP

The peer dependency range is `^4.22.0`. 4.22.0 is the oldest release supported.

**Why 4.22.0.** A stateful FastMCP server runs on mcp-proxy. Releases of mcp-proxy before 6.7.17 do not call `authenticate` for a `GET` (the event stream) or a `DELETE` (ending the session) on a session that is alive: they look the session up by `mcp-session-id` and pass the request on. Anyone who holds the session id could then open the stream or end the session without a token, and the session binding would never see the request. FastMCP 4.22.0 is the first release that requires mcp-proxy 6.7.19, so its range cannot resolve to one of those releases. FastMCP 4.21.2 and older accept affected releases (4.20 and older from 6.4.6, 4.21 from 6.7.13), so a lockfile can pin one.

**The `_meta` field.** When a tool fails, this package returns a tool result with `isError: true` and an `_meta` field that carries the kind of error (`insufficient_scope`, `invalid_token` or `server_error`). FastMCP releases before 4.7.0 reject `_meta` in a tool result. The client then receives a text that starts with `Tool '<name>' execution failed:` and contains `Unrecognized key: "_meta"`, and the real reason is lost.

**Versions run.** The unit, integration and documentation suites pass against these FastMCP releases:

| Release | Result |
| --- | --- |
| 4.22.0 (the floor) | Pass |
| 4.23.0 | Pass |
| 4.23.8 (the newest tried) | Pass |
| 4.7.0, with mcp-proxy 6.7.17, 6.7.18 or 6.7.19 | Pass |
| 4.7.0, with mcp-proxy 6.4.6, 6.5.3, 6.5.4, 6.5.5, 6.5.7, 6.6.0, 6.7.0, 6.7.13, 6.7.15 or 6.7.16 | Fail: the test for `GET` and `DELETE` on a bound session gets no refusal from `authenticate` |
| 4.0.0, 4.3.0, 4.4.0, 4.5.0, 4.6.0 | Fail, because of `_meta` |

These are samples, not every patch release. Releases from 4.7.0 to 4.21.2 are not supported because their range allows an affected mcp-proxy; the rows for 4.7.0 show what the pinned mcp-proxy decides. FastMCP 5 and later are outside the peer range and untested.

**Differences between releases.** A direct call to a tool hidden by `canAccess` fails with the JSON-RPC code -32601 on some 4.x releases and -32602 on others. In both cases the message contains `Unknown tool`, provided the caller can see at least one other tool. Match on the message, or accept either code.

## Protocol revisions

The integration tests send an `initialize` request to FastMCP with each of these revisions and get the same revision back: 2025-03-26, 2025-06-18 and 2025-11-25. FastMCP answers an `initialize` request for a newer revision with 2025-11-25. The adapter does nothing revision specific, so this page makes no statement about revisions beyond the three above.

## The MCP client used in the tests

The integration tests talk to FastMCP over real HTTP with the client of the MCP TypeScript SDK v2 (`@modelcontextprotocol/client`, version 2.3 or later). Other MCP clients have not been tried with this adapter.

## Transports

The tests cover only FastMCP's `httpStream` transport, in both its stateless and stateful modes. The adapter does not support the stdio transport: FastMCP calls `authenticate` with no request there, and the hook rejects with an error that names `transportType: "httpStream"`. It does not support the legacy SSE transport either: `GET /sse` is answered with 404.

## @auth0/ai-mcp

`@auth0/ai-mcp` is a peer dependency with the range `*`, so your application and this package share one copy. This package calls `authenticateRequest`, `buildProtectedResourceMetadata`, `buildWwwAuthenticate` and the request context functions of `@auth0/ai-mcp`. Use a release of `@auth0/ai-mcp` that exports them.

## What the tests do not cover

- A real Auth0 tenant. The suites sign tokens with a local key and intercept the requests to the tenant.
- Real DPoP-bound tokens. The tests use a token with a synthetic `cnf` claim.
- A reverse proxy in front of the server, and event streams that stay open for long.
- FastMCP's own OAuth login flows.
- More than one Node.js release.
