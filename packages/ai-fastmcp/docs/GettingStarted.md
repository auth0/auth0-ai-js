# Getting started

This guide takes a FastMCP server from an empty directory to a tool call that carries an Auth0 access token. It uses the stateless HTTP mode, which is the recommended setup (see [Stateless and stateful servers](./StatelessAndStateful.md)).

## What you need

- An Auth0 tenant.
- An API in that tenant whose identifier is the public URL of your MCP endpoint. For a local run that is `http://localhost:3000/mcp`. Access tokens must be issued for this identifier, which this package calls the audience.
- Node.js and a package manager.

With the [Auth0 CLI](https://github.com/auth0/auth0-cli), the API takes one command:

```bash
auth0 apis create --name "Orders MCP" --identifier "http://localhost:3000/mcp" --signing-alg RS256 --scopes "read:orders"
```

## 1. Install

```bash
npm install @auth0/ai-fastmcp @auth0/ai-mcp fastmcp zod
```

`@auth0/ai-mcp` and `fastmcp` are peer dependencies. The oldest FastMCP release supported is 4.7.0, see [Compatibility](./Compatibility.md).

## 2. Write the server

Create `server.ts`:

```ts
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { createFastMcpAuth, withAuth0Execute } from "@auth0/ai-fastmcp";

const auth = createFastMcpAuth({});
const server = new FastMCP({ name: "orders", version: "1.0.0", ...auth });

server.addTool({
  name: "whoami",
  description: "Returns the subject of the caller.",
  parameters: z.object({}),
  execute: withAuth0Execute(async (_args, { session }) => session?.principal.sub ?? "unknown"),
});

await server.start({ transportType: "httpStream", httpStream: { port: 3000, stateless: true } });
```

`createFastMcpAuth` returns two FastMCP options, `authenticate` and `oauth`. Spreading them into `new FastMCP({...})` is all the wiring there is. Passing `{}` means the settings come from the environment: you must set `AUTH0_DOMAIN` and `AUTH0_AUDIENCE`, and `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` matter only to tools that exchange tokens. [Configuration](./Configuration.md) shows the other two ways to pass them.

Do not set FastMCP's own `auth` option as well. FastMCP documents it as a provider that configures `authenticate` and `oauth` itself, and this package already supplies both.

## 3. Run it

```bash
export AUTH0_DOMAIN=your-tenant.us.auth0.com
export AUTH0_AUDIENCE=http://localhost:3000/mcp
npx tsx server.ts
```

The server listens on port 3000 and serves the MCP route at `/mcp`. Without a token it answers 401:

```bash
curl -i -X POST http://localhost:3000/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response is `401` with a `WWW-Authenticate` header that starts with `Bearer` and names the metadata document, and the body is `{"error":"unauthorized","error_description":"Authentication is required."}`.

## 4. Call it with a token

Any access token issued for the audience works. To get one for a first test, authorize a machine-to-machine application for the API and use its client credentials:

```bash
curl -s https://your-tenant.us.auth0.com/oauth/token \
  -H "content-type: application/json" \
  -d '{"grant_type":"client_credentials","client_id":"YOUR_CLIENT_ID","client_secret":"YOUR_CLIENT_SECRET","audience":"http://localhost:3000/mcp"}'
```

Put the `access_token` from the response in `ACCESS_TOKEN` and call the tool:

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

A stateless FastMCP server needs no `initialize` call first. The answer is a server-sent event whose `data:` line holds the JSON-RPC message:

```text
data: {"result":{"content":[{"type":"text","text":"THE_SUB_CLAIM_OF_THE_TOKEN"}]},"jsonrpc":"2.0","id":1}
```

## 5. See the metadata

The server publishes the protected resource metadata (RFC 9728) that MCP clients use to find your tenant. Both routes are public:

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
```

```json
{"resource":"http://localhost:3000/mcp","authorization_servers":["https://your-tenant.us.auth0.com/"],"bearer_methods_supported":["header"]}
```

## Next steps

- [Configuration](./Configuration.md): the three ways to pass settings, the `resource` and `endpoint` rule, metadata, required scopes.
- [Tools](./Tools.md): the session, per-tool scopes, and calling downstream APIs on behalf of the caller.
- [Token caching](./TokenCaching.md): reuse exchanged tokens.
- [Troubleshooting](./Troubleshooting.md): the messages you may see and what they mean.
