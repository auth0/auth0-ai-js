# Stateless and stateful servers

FastMCP serves HTTP in two modes. Use the stateless mode unless a tool needs state kept between requests.

## Stateless mode

```ts
import { FastMCP } from "fastmcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

const server = new FastMCP({ name: "orders", version: "1.0.0", ...createFastMcpAuth() });

await server.start({ transportType: "httpStream", httpStream: { port: 3000, stateless: true } });
```

In stateless mode FastMCP creates no session and issues no `mcp-session-id`. Every request carries its own access token and `authenticate` verifies it on its own. This is why it is the recommended mode:

- Any instance can serve any request, so you scale by running more instances behind a load balancer.
- No caller can ride on another caller's session, because no session exists.
- The session binding described below applies only to a request that carries a session id, and a stateless server issues none.

The trade-off is that there is no standalone event stream. FastMCP answers a `GET` or `DELETE` on the MCP route with 405 before `authenticate` runs.

## Stateful mode

With `stateless: false`, FastMCP keeps a session per client. The first response carries an `mcp-session-id` header, and the client sends it back on later requests. `authenticate` runs on every request, `GET` and `DELETE` included, so each request still needs a valid token.

FastMCP does not tie a session id to the caller that created it. If a second caller presents a valid token together with the first caller's `mcp-session-id`, FastMCP accepts the request and runs the call as the second caller. Anyone who gets hold of a session id, for example from a log, can try it with their own token, so this is worth closing.

## Session binding

`createFastMcpAuth` closes it with a session binding. The adapter remembers which subject (`sub`) used each `mcp-session-id` first, and answers any other subject on that id with 403:

```json
{"error":"forbidden","error_description":"The session belongs to a different caller."}
```

The response has no `WWW-Authenticate` header, because the credential is valid and a new token would not help. The owner of the session is not affected. It keeps calling with fresh tokens.

How it behaves:

- It applies only to requests that carry a session id. The first request of a session, `initialize`, has none, so it cannot be bound. The binding starts with the first later request that carries the id, which is normally the client's own follow-up.
- It is on by default. `sessionBinding: false` turns it off, and then FastMCP's behavior described above applies.
- The adapter answers a session id longer than 256 characters with 400 `invalid_request` and the description `The session id is not valid.`. FastMCP issues UUIDs, which are far shorter.
- It cannot tell which mode FastMCP runs in, so it binds a session id on any server that receives one. A stateless server behind a gateway that forwards a fixed or stale `mcp-session-id` binds that id to the first subject, and a second user behind the same id gets 403.
- It has limits. `sessionBinding: { maxSessions, maxSessionsPerSubject, ttlMs }` sets them. The defaults are 10000 session ids, 100 per subject, and 3600000 milliseconds (one hour) after the last use. Each use renews the time. A subject that reaches its limit replaces its own oldest id, and when the whole table is full the adapter forgets the least recently used id first. The values must be positive numbers, or `createFastMcpAuth` throws `InvalidConfigurationError`. A value of `maxSessionsPerSubject` above `maxSessions` has no effect, because the whole table never holds more.

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({
  sessionBinding: { maxSessions: 1000, ttlMs: 15 * 60 * 1000 },
});
```

## Limits of the binding

- **One process.** The table lives in the memory of the process. Instances do not share it, and a restart empties it.
- **Forgotten ids.** When the adapter evicts an id, when an id expires, or when a restart empties the table, the next subject that presents the id owns it. That is what FastMCP does without the binding.
- **Ids FastMCP never issued are recorded too.** `authenticate` runs before FastMCP looks the session up, so the binding records the id of any request that passes authentication, issued or not. Without a limit per subject, one caller could send `maxSessions` requests with random ids and push every other subject's binding out of the table, and then take over a session id they had learned. The limit per subject keeps a caller's ids to their own: at the limit, a new id replaces that caller's oldest one. It raises the cost of the attack and does not end it. Several accounts together can still fill the table, and on a tenant with open sign-up creating accounts is cheap. Raise `maxSessionsPerSubject` for a subject that legitimately holds many sessions, for example a gateway that uses one client credentials token. Stateless mode is the fix.
- **An idle stream outlives its binding.** The adapter forgets an id `ttlMs` after its last request. mcp-proxy closes a session that has had no request for 30 minutes, except while an event stream is open on it. The token of a stream is checked only when the stream opens, so a client that holds one open for longer than `ttlMs` leaves a live session without a binding, and another subject who knows the id can then take it. Set `ttlMs` above the longest stream you expect.
- **The first request with an id wins.** The binding starts with the first request that carries the id, whoever sends it. A caller who learns another caller's id before that caller's first follow-up owns the id, and the real owner is then refused. Treat session ids as secrets: keep them out of logs and URLs.

If your deployment has several instances, or you cannot accept these limits, run stateless.
