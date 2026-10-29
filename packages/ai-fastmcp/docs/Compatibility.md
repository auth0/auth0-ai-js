# Compatibility

This page lists what the test suites of this package ran against, and nothing beyond that. A version or revision that is not listed here has not been tried.

## FastMCP

The peer dependency range is `^4.7.0`. 4.7.0 is the oldest release supported.

**Why 4.7.0.** When a tool fails, this package returns a tool result with `isError: true` and an `_meta` field that carries the kind of error (`insufficient_scope`, `invalid_token` or `server_error`). FastMCP releases before 4.7.0 reject `_meta` in a tool result. The client then receives a text that starts with `Tool '<name>' execution failed:` and contains `Unrecognized key: "_meta"`, and the real reason is lost.

**Versions run.** The unit, integration and documentation suites pass against these FastMCP releases:

| Release | Result |
| --- | --- |
| 4.7.0 (the floor) | Pass |
| 4.10.0, 4.13.0, 4.16.0, 4.19.0, 4.21.0, 4.22.0, 4.23.0 | Pass |
| 4.23.8 (the newest tried) | Pass |
| 4.0.0, 4.3.0, 4.4.0, 4.5.0, 4.6.0 | Fail, because of `_meta` |

These are samples, not every patch release. 4.1 and 4.2 were not run. FastMCP 5 and later are outside the peer range and untested.

**Differences between releases.** A direct call to a tool hidden by `canAccess` fails with the JSON-RPC code -32601 on some 4.x releases and -32602 on others. In both cases the message contains `Unknown tool`, provided the caller can see at least one other tool. Match on the message, or accept either code.

## Protocol revisions

The integration tests send an `initialize` request to FastMCP with each of these revisions and get the same revision back: 2025-03-26, 2025-06-18 and 2025-11-25. FastMCP answers an `initialize` request for a newer revision with 2025-11-25. The adapter does nothing revision specific, so this page makes no statement about revisions beyond the three above.

## The MCP client used in the tests

The integration tests talk to FastMCP over real HTTP with the client of the MCP TypeScript SDK v2 (`@modelcontextprotocol/client`, version 2.3 or later). Other MCP clients have not been tried with this adapter.

## Transports

The tests cover only FastMCP's `httpStream` transport, in both its stateless and stateful modes. The stdio transport is not tested.

## @auth0/ai-mcp

`@auth0/ai-mcp` is a peer dependency with the range `*`, so your application and this package share one copy. This package calls `authenticateRequest`, `buildProtectedResourceMetadata`, `buildWwwAuthenticate` and the request context functions of `@auth0/ai-mcp`. Use a release of `@auth0/ai-mcp` that exports them.

## What the tests do not cover

- A real Auth0 tenant. The suites sign tokens with a local key and intercept the requests to the tenant.
- Real DPoP-bound tokens. The tests use a token with a synthetic `cnf` claim.
- A reverse proxy in front of the server, and event streams that stay open for long.
- FastMCP's own OAuth login flows.
- More than one Node.js release.
