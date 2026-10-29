# Orders MCP server on FastMCP with Auth0 token delegation

A small MCP server built with FastMCP and `@auth0/ai-fastmcp`. It plays an order assistant. It checks the access token on every request, then calls an orders API as the signed-in shopper (an on-behalf-of token exchange). A second small process plays the orders API and verifies every token it receives.

## What it shows

- `src/auth.ts` holds all the Auth0 wiring: one `createFastMcpAuth` call with a token store. The tenant settings come from the environment (`AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`), so the call passes none of them. `src/app.ts` spreads the two options it returns into `new FastMCP({...})`, and `src/tools.ts` holds only the tools. The server runs in the stateless HTTP mode. A request without a valid token gets a `WWW-Authenticate` challenge before any tool runs, and the server publishes its protected resource metadata (RFC 9728).
- `whoami` needs no scope beyond a valid token. It reports the subject, the client and the scopes of the caller.
- `list_orders` exchanges the caller's token for a token to the orders API with the `read:orders` scope, through `getCallerMcpClientOrThrow()`, and lists the orders. A second call with the same access token reuses the saved token.
- `cancel_order` (required argument `order_id`) needs the scope `tool:cancel_order`, set with `requiredScopes` on `withAuth0Execute`. A caller without it gets an error result for that tool only (HTTP 200) and no exchange takes place. With the scope, the tool exchanges for a token with `write:orders`, through `session.mcpClient`, and cancels the order.
- Only the exchanged token goes to the orders API, never the caller's own token. Expected failures, such as an unknown order, reach the caller as a `UserError` with a fixed message. Anything unexpected becomes `Tool execution failed.`, and the tool logs the error name and never its message. Each call stops after `DOWNSTREAM_TIMEOUT_MS`.
- `src/orders-api.ts` verifies every token (RS256 signature from the tenant JWKS, issuer, the audience of the orders API, expiry, subject and scope) before it returns data. Each answer includes a `verified` block that names the audience, the scope and the acting client of the token if it carries an `act` claim, never the token itself.

Seed data lives in memory and resets on restart: ord_1001 (shipped), ord_1002 and ord_1003 (processing).

## Set up your tenant

The tenant setup is the one of the [`ai-mcp-server` example](../ai-mcp-server/README.md#set-up-your-tenant), with fewer pieces: this example has no analytics service, so it needs no client credentials grant. Use these two APIs in step 1 in place of the four there, and these grants in step 3:

```bash
auth0 apis create --name "Orders MCP" --identifier "http://localhost:3001/mcp" --signing-alg RS256 \
  --scopes "tool:cancel_order"
auth0 apis create --name "Orders Service" --identifier "https://orders.api/" --signing-alg RS256 \
  --scopes "read:orders,write:orders"
auth0 api post client-grants --data '{"client_id":"YOUR_EXCHANGE_CLIENT_ID","audience":"https://orders.api/","scope":["read:orders","write:orders"],"subject_type":"user"}'
```

On-behalf-of token exchange must be enabled on your tenant, and the exchange client must be a Custom API client tied to the MCP API. That README explains both. In step 6, list `tool:cancel_order` as the tool scope of the grant to the MCP API. The exchange client's id and secret go in `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`.

A real MCP client signs in through your tenant, so the tenant has to accept that client. [MCP clients and tenant settings](../../packages/ai-mcp/docs/McpClients.md) explains what that takes for Claude Code. This example was not tried with a specific MCP client. Any client that follows the protected resource metadata of the server and supports OAuth should be able to sign in.

## Run

```sh
cp .env.example .env   # fill in the domain, client id and secret
npm run start:api      # orders API on port 3003
npm run start          # MCP server on port 3001, in a second terminal
```

Node's `--env-file` support reads the `.env` file, so you need no extra package. The MCP URL ends in `/mcp`.

To call the server without an MCP client, send a request with an access token issued for `AUTH0_AUDIENCE`:

```sh
curl -s -X POST http://localhost:3001/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

`whoami` works with any such token. `list_orders` and `cancel_order` exchange the token on behalf of a user, so they need a token that a user signed in for, because the grants use `subject_type` `user`.

With `MCP_REQUIRED_SCOPES` unset, any signed-in caller reaches the server and each tool checks its own scope.

## Check

```sh
npm run type-check
npm run lint
npm run build
npm test
```

The example needs FastMCP 4.7.0 or newer, the oldest release `@auth0/ai-fastmcp` supports. `npm test` fails if the resolved copy of FastMCP is older.

`npm test` runs both servers on loopback with a mocked Auth0 tenant. It makes no network calls.
