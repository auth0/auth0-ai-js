# Stateless and stateful servers

FastMCP serves HTTP in two modes. Use the stateless mode unless a tool needs state kept between requests.

## Stateless mode

```ts
import { FastMCP } from "fastmcp";
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

const server = new FastMCP({ name: "orders", version: "1.0.0", ...createFastMcpAuth({}) });

await server.start({ transportType: "httpStream", httpStream: { port: 3000, stateless: true } });
```

In stateless mode FastMCP creates no session and issues no `mcp-session-id`. Every request carries its own access token and `authenticate` verifies it on its own. This is why it is the recommended mode:

- Any instance can serve any request, so you scale by running more instances behind a load balancer.
- No caller can ride on another caller's session, because no session exists.
- The session binding described below never applies, because requests carry no session id.

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
- It has limits. `sessionBinding: { maxSessions, ttlMs }` sets them. The defaults are 10000 session ids and 3600000 milliseconds (one hour) after the last use. Each use renews the time, and when the table is full the adapter forgets the least recently used id first. Both values must be positive numbers, or `createFastMcpAuth` throws `InvalidConfigurationError`.

```ts
import { createFastMcpAuth } from "@auth0/ai-fastmcp";

export const auth = createFastMcpAuth({
  sessionBinding: { maxSessions: 1000, ttlMs: 15 * 60 * 1000 },
});
```

## Limits of the binding

- **One process.** The table lives in the memory of the process. Instances do not share it, and a restart empties it.
- **Forgotten ids.** When the adapter evicts an id, when an id expires, or when a restart empties the table, the next subject that presents the id owns it. That is what FastMCP does without the binding.
- **The first request with an id wins.** The binding starts with the first request that carries the id, whoever sends it. A caller who learns another caller's id before that caller's first follow-up owns the id, and the real owner is then refused. Treat session ids as secrets: keep them out of logs and URLs.

If your deployment has several instances, or you cannot accept these limits, run stateless.
