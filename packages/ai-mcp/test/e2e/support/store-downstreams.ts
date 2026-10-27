/**
 * Four pretend store services (Orders, Inventory, Analytics, Ledger), each a separate HTTP server
 * that verifies the bearer JWT itself. A service checks, for every request: RS256 signature against
 * the JWKS it was given, issuer, that service's own audience, expiry, not-before, a present `sub`,
 * and the scope the route needs. It trusts no header and never accepts a token minted for another
 * service. The token is never logged or echoed.
 *
 * This file is also loaded directly by Node in `downstream-server.mjs` (type stripping, so it
 * stays free of enums, parameter properties and relative imports). Keep it that way.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

export type ServiceName = "orders" | "inventory" | "analytics" | "ledger";

export const SERVICE_NAMES: readonly ServiceName[] = ["orders", "inventory", "analytics", "ledger"];

/** Scope each route needs. Override per service through `scopes` when a tenant uses other names. */
export interface ServiceScopes {
  readOrders: string;
  readInventory: string;
  writeInventory: string;
  readAnalytics: string;
  readLedger: string;
}

export const DEFAULT_SCOPES: ServiceScopes = {
  readOrders: "read:orders",
  readInventory: "read:inventory",
  writeInventory: "write:inventory",
  readAnalytics: "read:analytics",
  readLedger: "read:ledger",
};

export type DownstreamOutcome = "ok" | "no_bearer" | "invalid_token" | "insufficient_scope";

/** One request seen by a service. Claim fields are present only after the signature verified. */
export interface DownstreamLogEntry {
  service: ServiceName;
  ts: string;
  sub?: string;
  aud?: string | string[];
  scope?: string;
  act?: { sub?: string; act?: { sub?: string } };
  org_id?: string;
  outcome: DownstreamOutcome;
}

export interface StartDownstreamsOptions {
  /** JWKS document URL the services verify signatures against. */
  jwksUri: string;
  /** Expected `iss`, compared exactly (Auth0 issuers end with a slash). */
  issuer: string;
  /** Audience each service accepts. A token for another service's audience is rejected. */
  audiences: Record<ServiceName, string>;
  scopes?: Partial<ServiceScopes>;
  /**
   * First port. Services listen on port, port + 1, port + 2, port + 3 in the order
   * orders, inventory, analytics, ledger. Omit to let the OS pick free ports.
   */
  port?: number;
  /** Interface to bind. Defaults to loopback. */
  host?: string;
  /** Called for each log entry as it is recorded. */
  onRequest?: (entry: DownstreamLogEntry) => void;
}

export interface Downstreams {
  /** Base URL of each service, for example `http://127.0.0.1:41234`. */
  urls: Record<ServiceName, string>;
  ports: Record<ServiceName, number>;
  /** Every request seen, all services, in arrival order. Never contains token material. */
  log: DownstreamLogEntry[];
  close(): Promise<void>;
}

interface SeedOrder {
  id: string;
  item: string;
  sku: string;
  qty: number;
  status: string;
}

const SEED_ORDERS: readonly SeedOrder[] = [
  { id: "ORD-1001", item: "Wireless Headphones", sku: "SKU-HEAD-01", qty: 1, status: "shipped" },
  { id: "ORD-1002", item: "Mechanical Keyboard", sku: "SKU-KEYB-02", qty: 1, status: "processing" },
  { id: "ORD-1003", item: "USB-C Dock", sku: "SKU-DOCK-03", qty: 2, status: "processing" },
];

const SEED_STOCK: Readonly<Record<string, number>> = {
  "SKU-HEAD-01": 24,
  "SKU-KEYB-02": 12,
  "SKU-DOCK-03": 7,
  "SKU-CAM-04": 15,
};

const SEED_LEDGER = [
  { id: "LED-1", order_id: "ORD-1001", amount_usd: 129.0, kind: "payment" },
  { id: "LED-2", order_id: "ORD-1002", amount_usd: 89.5, kind: "payment" },
  { id: "LED-3", order_id: "ORD-1003", amount_usd: 98.0, kind: "payment" },
];

interface RouteMatch {
  scope: string;
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

interface Verified {
  payload: JWTPayload;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | undefined {
  return /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/.exec(req.headers.authorization ?? "")?.[1];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 8192) throw new Error("too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function logEntry(service: ServiceName, outcome: DownstreamOutcome, verified?: Verified): DownstreamLogEntry {
  const entry: DownstreamLogEntry = { service, ts: new Date().toISOString(), outcome };
  const payload = verified?.payload;
  if (payload !== undefined) {
    if (typeof payload.sub === "string") entry.sub = payload.sub;
    if (payload.aud !== undefined) entry.aud = payload.aud;
    if (typeof payload["scope"] === "string") entry.scope = payload["scope"];
    const act = payload["act"];
    if (act !== null && typeof act === "object") entry.act = act as DownstreamLogEntry["act"];
    if (typeof payload["org_id"] === "string") entry.org_id = payload["org_id"];
  }
  return entry;
}

function createService(
  service: ServiceName,
  options: StartDownstreamsOptions,
  scopes: ServiceScopes,
  record: (entry: DownstreamLogEntry) => void,
): Server {
  const audience = options.audiences[service];
  const getKey = createRemoteJWKSet(new URL(options.jwksUri));
  const stock = new Map(Object.entries(SEED_STOCK));
  const reserved = new Set<string>();

  function resolve(method: string, path: string): RouteMatch | undefined {
    const parts = path.split("/").filter((part) => part.length > 0);
    const [prefix, id, action] = parts;
    if (prefix !== service) return undefined;
    if (service === "orders" && method === "GET" && parts.length <= 2) {
      return {
        scope: scopes.readOrders,
        run: (_req, res) => {
          if (id === undefined) return send(res, 200, { orders: SEED_ORDERS });
          const order = SEED_ORDERS.find((o) => o.id === id);
          if (!order) return send(res, 404, { error: "not_found" });
          send(res, 200, { order });
        },
      };
    }
    if (service === "inventory" && method === "GET" && parts.length <= 2) {
      return {
        scope: scopes.readInventory,
        run: (_req, res) => {
          if (id === undefined) {
            return send(res, 200, { products: [...stock.entries()].map(([sku, left]) => ({ sku, stock: left })) });
          }
          const left = stock.get(id);
          if (left === undefined) return send(res, 404, { error: "not_found" });
          send(res, 200, { sku: id, stock: left });
        },
      };
    }
    if (service === "inventory" && method === "POST" && action === "reserve" && parts.length === 3 && id) {
      return {
        scope: scopes.writeInventory,
        run: async (req, res) => {
          let body: unknown;
          try {
            body = await readJson(req);
          } catch {
            return send(res, 400, { error: "bad_request" });
          }
          const { qty, order_id: orderId } = (body ?? {}) as Record<string, unknown>;
          if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || typeof orderId !== "string") {
            return send(res, 400, { error: "bad_request" });
          }
          const current = stock.get(id);
          if (current === undefined || !SEED_ORDERS.some((o) => o.id === orderId)) {
            return send(res, 404, { error: "not_found" });
          }
          if (reserved.has(orderId)) {
            return send(res, 200, { sku: id, order_id: orderId, qty, stock_before: current, stock_after: current, already_reserved: true });
          }
          if (current < qty) return send(res, 409, { error: "insufficient_stock" });
          stock.set(id, current - qty);
          reserved.add(orderId);
          send(res, 200, { sku: id, order_id: orderId, qty, stock_before: current, stock_after: current - qty, already_reserved: false });
        },
      };
    }
    if (service === "analytics" && method === "GET" && id === "monthly-revenue" && parts.length === 2) {
      return {
        scope: scopes.readAnalytics,
        run: (_req, res) => send(res, 200, { revenue_usd: 142000, top_product: "Enterprise Suite" }),
      };
    }
    if (service === "ledger" && method === "GET" && parts.length <= 2) {
      return {
        scope: scopes.readLedger,
        run: (_req, res) => {
          if (id === undefined) return send(res, 200, { entries: SEED_LEDGER });
          const entry = SEED_LEDGER.find((e) => e.id === id);
          if (!entry) return send(res, 404, { error: "not_found" });
          send(res, 200, { entry });
        },
      };
    }
    return undefined;
  }

  const reject = (res: ServerResponse, challenge: string) =>
    send(res, 401, { error: "invalid_token" }, { "www-authenticate": challenge });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = resolve(req.method ?? "GET", url.pathname);
    if (route === undefined) return send(res, 404, { error: "not_found" });

    const token = bearerToken(req);
    if (token === undefined) {
      record(logEntry(service, "no_bearer"));
      return reject(res, "Bearer");
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, {
        issuer: options.issuer,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      }));
    } catch {
      record(logEntry(service, "invalid_token"));
      return reject(res, 'Bearer error="invalid_token"');
    }
    const granted = typeof payload["scope"] === "string" ? payload["scope"].split(/\s+/) : [];
    if (!granted.includes(route.scope)) {
      record(logEntry(service, "insufficient_scope", { payload }));
      return send(res, 403, { error: "insufficient_scope" }, {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${route.scope}"`,
      });
    }
    record(logEntry(service, "ok", { payload }));
    await route.run(req, res);
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "server_error" });
      else res.end();
    });
  });
}

export async function startDownstreams(options: StartDownstreamsOptions): Promise<Downstreams> {
  const scopes: ServiceScopes = { ...DEFAULT_SCOPES, ...options.scopes };
  const host = options.host ?? "127.0.0.1";
  const log: DownstreamLogEntry[] = [];
  const record = (entry: DownstreamLogEntry) => {
    log.push(entry);
    options.onRequest?.(entry);
  };
  const servers = {} as Record<ServiceName, Server>;
  const ports = {} as Record<ServiceName, number>;
  const urls = {} as Record<ServiceName, string>;
  const close = async () => {
    await Promise.all(
      Object.values(servers).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  };
  try {
    for (const [index, service] of SERVICE_NAMES.entries()) {
      const server = createService(service, options, scopes, record);
      servers[service] = server;
      const wanted = options.port === undefined ? 0 : options.port + index;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(wanted, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      ports[service] = (server.address() as AddressInfo).port;
      urls[service] = `http://${host}:${ports[service]}`;
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { urls, ports, log, close };
}
