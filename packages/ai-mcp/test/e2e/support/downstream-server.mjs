/**
 * Child-process entry for the store downstream services.
 *
 * Run with plain Node (22.18 or newer, which strips TypeScript types by default):
 *
 *   node test/e2e/support/downstream-server.mjs
 *
 * It imports store-downstreams.ts directly, so there is no build step. That file therefore avoids
 * enums, parameter properties and relative imports. Vitest specs use the same .ts file in process.
 *
 * Configuration comes from the environment:
 *   DOWNSTREAM_JWKS_URI       JWKS document URL (required)
 *   DOWNSTREAM_ISSUER         expected iss, exact (required)
 *   DOWNSTREAM_AUD_ORDERS, DOWNSTREAM_AUD_INVENTORY, DOWNSTREAM_AUD_ANALYTICS,
 *   DOWNSTREAM_AUD_LEDGER     audience each service accepts (required)
 *   DOWNSTREAM_PORT           first port, services take port..port+3 (optional, default free ports)
 *   DOWNSTREAM_HOST           interface (optional, default 127.0.0.1)
 *   DOWNSTREAM_SCOPES         JSON object overriding scope names, for example {"readOrders":"orders:r"}
 *
 * Output on stdout, one JSON object per line and never any token material:
 *   {"event":"listening","urls":{...},"ports":{...}}   once, after all services listen
 *   {"event":"request","service":...,"outcome":...}      one per request seen, including rejections
 *
 * SIGTERM and SIGINT close the servers and exit 0.
 */
import { startDownstreams } from "./store-downstreams.ts";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    process.stderr.write(`missing required environment variable ${name}\n`);
    process.exit(2);
  }
  return value.trim();
}

const port = process.env.DOWNSTREAM_PORT?.trim();
const scopes = process.env.DOWNSTREAM_SCOPES?.trim();

const downstreams = await startDownstreams({
  jwksUri: required("DOWNSTREAM_JWKS_URI"),
  issuer: required("DOWNSTREAM_ISSUER"),
  audiences: {
    orders: required("DOWNSTREAM_AUD_ORDERS"),
    inventory: required("DOWNSTREAM_AUD_INVENTORY"),
    analytics: required("DOWNSTREAM_AUD_ANALYTICS"),
    ledger: required("DOWNSTREAM_AUD_LEDGER"),
  },
  ...(port ? { port: Number(port) } : {}),
  ...(process.env.DOWNSTREAM_HOST?.trim() ? { host: process.env.DOWNSTREAM_HOST.trim() } : {}),
  ...(scopes ? { scopes: JSON.parse(scopes) } : {}),
  onRequest: (entry) => process.stdout.write(`${JSON.stringify({ event: "request", ...entry })}\n`),
});

process.stdout.write(`${JSON.stringify({ event: "listening", urls: downstreams.urls, ports: downstreams.ports })}\n`);

const shutdown = () => {
  downstreams.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
