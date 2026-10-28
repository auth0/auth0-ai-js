# Examples

Each recipe is a complete module. Replace the placeholder domain, audiences and scopes with your own.

- [A complete server with a token exchange](#a-complete-server-with-a-token-exchange)
- [Overlapping scopes with a shared, encrypted cache](#overlapping-scopes-with-a-shared-encrypted-cache)
- [Restricting a server to specific organizations](#restricting-a-server-to-specific-organizations)
- [Requiring DPoP](#requiring-dpop)
- [Calling a third-party API with Token Vault](#calling-a-third-party-api-with-token-vault)
- [Unit testing a tool](#unit-testing-a-tool)

## A complete server with a token exchange

A Node server that requires an `mcp:access` scope for every request, gates one tool on its own scope, and calls a downstream API with an exchanged token. The tool catches the package's errors and answers with generic `isError` results, so nothing from an upstream response reaches the caller.

```ts
import { createServer } from 'node:http';
import {
  DownscopedTokenError,
  InsufficientScopeError,
  MemoryIndexedTokenStore,
  createMcpClient,
  getCallerMcpClientOrThrow,
  getCallerPrincipal,
  withRequiredScopes,
} from '@auth0/ai-mcp';
import { createNodeMcpHandler } from '@auth0/ai-mcp/mcp-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const DOWNSTREAM = 'https://reports-api.example.com';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: RESOURCE,
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  tokenStore: new MemoryIndexedTokenStore(),
});

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function failure(message: string) {
  return { ...text(message), isError: true as const };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'reports', version: '1.0.0' });

  server.registerTool(
    'whoami',
    { description: 'Returns the identity of the caller.' },
    async () => {
      const principal = getCallerPrincipal();
      return text(JSON.stringify({ sub: principal?.sub, org: principal?.orgId }));
    },
  );

  server.registerTool(
    'list_reports',
    { description: 'Lists reports using the identity of the caller.' },
    withRequiredScopes('tool:list_reports', async () => {
      try {
        const token = await getCallerMcpClientOrThrow().getTokenOnBehalfOf({
          audience: DOWNSTREAM,
          scope: 'read:reports',
        });
        const response = await fetch(`${DOWNSTREAM}/reports`, {
          headers: { authorization: `Bearer ${token.accessToken}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          return failure(`The reports API answered ${response.status}.`);
        }
        return text(await response.text());
      } catch (error) {
        // Log the class only. Messages can carry details that must not reach logs or callers.
        console.error('list_reports failed', error instanceof Error ? error.name : 'unknown');
        if (error instanceof DownscopedTokenError || error instanceof InsufficientScopeError) {
          return failure('The caller is not permitted to read reports.');
        }
        return failure('The reports could not be retrieved.');
      }
    }),
  );

  return server;
}

const handler = createNodeMcpHandler({
  client,
  requiredScopes: ['mcp:access'],
  metadata: {
    scopesSupported: ['mcp:access', 'tool:list_reports'],
    resourceName: 'Reports MCP server',
  },
  createServer: buildServer,
  onError: (error) => console.error('mcp error', error instanceof Error ? error.name : 'unknown'),
});

createServer((req, res) => void handler(req, res)).listen(3000);
```

## Overlapping scopes with a shared, encrypted cache

When your tools request overlapping scope sets for the same downstream API, `non_strict` matching reuses a broader cached token for a narrower request. It needs an indexed store. The encrypted wrapper keeps tokens unreadable in the inner store.

```ts
import {
  MemoryIndexedTokenStore,
  createEncryptedTokenStore,
  createMcpClient,
  getCallerMcpClientOrThrow,
} from '@auth0/ai-mcp';

const secret = process.env.TOKEN_STORE_SECRET;
if (secret === undefined) {
  throw new Error('TOKEN_STORE_SECRET is not set.');
}

export const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  tokenStore: createEncryptedTokenStore(new MemoryIndexedTokenStore({ maxEntries: 10_000 }), { secret }),
  scopeMatching: 'non_strict',
});

// Inside tools: the second call reuses the token from the first.
export async function twoCalls(): Promise<void> {
  const mcpClient = getCallerMcpClientOrThrow();
  await mcpClient.getTokenOnBehalfOf({ audience: 'https://reports-api.example.com', scope: 'read:reports write:reports' });
  await mcpClient.getTokenOnBehalfOf({ audience: 'https://reports-api.example.com', scope: 'read:reports' });
}
```

In production, replace `MemoryIndexedTokenStore` with a store on shared storage. See [Writing a store](./docs/TokenCaching.md#writing-a-store).

## Restricting a server to specific organizations

```ts
import { createMcpClient, createMcpHandler, getCallerPrincipal } from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  organizationPolicy: 'required',
  organizationId: ['org_abc123', 'org_def456'],
});

export const handle = createMcpHandler({
  client,
  handler: async () => Response.json({ organization: getCallerPrincipal()?.orgId }),
});
```

The handler answers tokens without an `org_id` claim, and tokens from other organizations, with a 401 before your handler runs.

## Requiring DPoP

```ts
import { createMcpClient, createMcpHandler } from '@auth0/ai-mcp';

const client = createMcpClient({
  domain: 'your-tenant.us.auth0.com',
  audience: 'https://mcp.example.com/mcp',
  dpop: { mode: 'required' },
});

export const handle = createMcpHandler({
  client,
  handler: async () => Response.json({ ok: true }),
});
```

Requests must send `Authorization: DPoP <token>` and a `DPoP` proof header. The handler answers Bearer requests with a DPoP challenge, and the metadata document declares DPoP-bound tokens as mandatory. The handler checks the proof against `request.url`, so behind a proxy make sure the handler sees the public URL.

## Calling a third-party API with Token Vault

```ts
import { getCallerMcpClientOrThrow } from '@auth0/ai-mcp';

export async function listFiles(): Promise<unknown> {
  const token = await getCallerMcpClientOrThrow().getTokenForService({
    connection: 'google-oauth2',
    loginHint: 'user@example.com',
  });
  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  return response.json();
}
```

## Unit testing a tool

A tool reads its caller from the request context, so a test only has to supply one. `RequestContext` is a plain object with a principal and a request-scoped client, which you can stub:

```ts
import { getCallerPrincipal, runWithRequestContext, withRequiredScopes } from '@auth0/ai-mcp';
import type { Principal, RequestContext } from '@auth0/ai-mcp';

const principal: Principal = {
  sub: 'auth0|user-1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scopes: ['tool:list_reports'],
  permissions: null,
  clientId: 'client-1',
  orgId: null,
};

const context: RequestContext = {
  principal,
  mcpClient: {
    getPrincipal: () => principal,
    getTokenOnBehalfOf: async () => {
      throw new Error('not used in this test');
    },
    getClientCredentialsToken: async () => {
      throw new Error('not used in this test');
    },
    getTokenForService: async () => {
      throw new Error('not used in this test');
    },
  },
};

const tool = withRequiredScopes('tool:list_reports', async () => getCallerPrincipal()?.sub);

export async function runTool() {
  return runWithRequestContext(context, () => tool());
}
```
