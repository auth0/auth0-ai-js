/**
 * Offline unit tests for the store downstream verifier. No tenant is involved: tokens are signed
 * with a locally generated RSA key and a local JWKS server stands in for the tenant. This checks
 * the verifier's own logic, not Auth0 behavior.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDownstreams } from "./store-downstreams.js";
import type { Downstreams } from "./store-downstreams.js";

const ISSUER = "https://tenant.example.test/";
const AUD = {
  orders: "https://api.example.test/orders",
  inventory: "https://api.example.test/inventory",
  analytics: "https://api.example.test/analytics",
  ledger: "https://api.example.test/ledger",
};
const KID = "unit-key";

interface TokenOptions {
  aud?: string | string[];
  iss?: string;
  scope?: string;
  sub?: string | null;
  exp?: number | string;
  nbf?: number | string;
  extra?: Record<string, unknown>;
}

let privateKey: CryptoKey;
let publicJwk: JWK;
let jwksServer: Server;
let jwksUri: string;
let downstreams: Downstreams;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function sign(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    ...(options.scope !== undefined && { scope: options.scope }),
    ...options.extra,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? AUD.orders)
    .setIssuedAt(now() - 10)
    .setExpirationTime(options.exp ?? now() + 300);
  if (options.sub !== null) jwt.setSubject(options.sub ?? "auth0|user-1");
  if (options.nbf !== undefined) jwt.setNotBefore(options.nbf);
  return jwt.sign(privateKey);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function get(url: string, token?: string, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/.well-known/jwks.json`;
  downstreams = await startDownstreams({ jwksUri, issuer: ISSUER, audiences: AUD });
});

afterAll(async () => {
  await downstreams?.close();
  jwksServer?.closeAllConnections();
  await new Promise<void>((resolve) => jwksServer?.close(() => resolve()));
});

describe("store downstream verifier", () => {
  it("serves every read route to a matching token", async () => {
    const reads: Array<[keyof typeof AUD, string, string]> = [
      ["orders", "/orders", "read:orders"],
      ["orders", "/orders/ORD-1001", "read:orders"],
      ["inventory", "/inventory", "read:inventory"],
      ["inventory", "/inventory/SKU-HEAD-01", "read:inventory"],
      ["analytics", "/analytics/monthly-revenue", "read:analytics"],
      ["ledger", "/ledger", "read:ledger"],
      ["ledger", "/ledger/LED-1", "read:ledger"],
    ];
    for (const [service, path, scope] of reads) {
      const token = await sign({ aud: AUD[service], scope });
      const res = await get(`${downstreams.urls[service]}${path}`, token);
      expect(res.status, `${service}${path}`).toBe(200);
    }
  });

  it("rejects a wrong audience", async () => {
    const token = await sign({ aud: "https://api.example.test/other", scope: "read:orders" });
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
  });

  it("rejects a token minted for another service even when the scope matches", async () => {
    const token = await sign({ aud: AUD.inventory, scope: "read:orders read:inventory" });
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
    expect((await get(`${downstreams.urls.inventory}/inventory`, token)).status).toBe(200);
  });

  it("accepts a token whose aud array includes the service audience", async () => {
    const token = await sign({ aud: [AUD.orders, AUD.ledger], scope: "read:orders read:ledger" });
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(200);
    expect((await get(`${downstreams.urls.ledger}/ledger`, token)).status).toBe(200);
  });

  it("rejects a wrong issuer", async () => {
    const token = await sign({ iss: "https://evil.example.test/", scope: "read:orders" });
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
  });

  it("answers 403 with the needed scope when the token is under-scoped", async () => {
    const token = await sign({ aud: AUD.inventory, scope: "read:inventory" });
    const res = await get(`${downstreams.urls.inventory}/inventory/SKU-HEAD-01/reserve`, token, "POST", {
      qty: 1,
      order_id: "ORD-1001",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('scope="write:inventory"');
  });

  it("applies the write route only with write:inventory", async () => {
    const token = await sign({ aud: AUD.inventory, scope: "read:inventory write:inventory" });
    const res = await get(`${downstreams.urls.inventory}/inventory/SKU-CAM-04/reserve`, token, "POST", {
      qty: 1,
      order_id: "ORD-1001",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sku: "SKU-CAM-04", stock_before: 15, stock_after: 14 });
  });

  it("rejects alg none", async () => {
    const header = b64url({ alg: "none", typ: "JWT" });
    const payload = b64url({ iss: ISSUER, aud: AUD.orders, sub: "auth0|user-1", scope: "read:orders", exp: now() + 300 });
    const res = await get(`${downstreams.urls.orders}/orders`, `${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it("rejects HS256 signed with the public key as the secret", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
    const token = await new SignJWT({ scope: "read:orders" })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD.orders)
      .setSubject("auth0|user-1")
      .setExpirationTime(now() + 300)
      .sign(secret);
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const token = await sign({ scope: "read:orders", exp: now() - 60 });
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
  });

  it("rejects a token that is not valid yet", async () => {
    const token = await sign({ scope: "read:orders", nbf: now() + 600 });
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
  });

  it("rejects a token without sub", async () => {
    const token = await sign({ scope: "read:orders", sub: null });
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
  });

  it("rejects a token signed by an unknown key", async () => {
    const other = await generateKeyPair("RS256");
    const token = await new SignJWT({ scope: "read:orders" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD.orders)
      .setSubject("auth0|user-1")
      .setExpirationTime(now() + 300)
      .sign(other.privateKey);
    expect((await get(`${downstreams.urls.orders}/orders`, token)).status).toBe(401);
  });

  it("answers 401 without a bearer and ignores identity headers", async () => {
    const res = await fetch(`${downstreams.urls.orders}/orders`, {
      headers: { "x-user-id": "auth0|admin", "x-scope": "read:orders" },
    });
    expect(res.status).toBe(401);
  });

  it("logs outcomes with claims for verified tokens and no token material", async () => {
    const before = downstreams.log.length;
    const token = await sign({
      aud: AUD.ledger,
      scope: "read:ledger",
      sub: "auth0|log-user",
      extra: { org_id: "org_123", act: { sub: "client-a" } },
    });
    await get(`${downstreams.urls.ledger}/ledger`, token);
    await get(`${downstreams.urls.ledger}/ledger`, "not.a.jwt");
    await get(`${downstreams.urls.ledger}/ledger`);
    const entries = downstreams.log.slice(before);
    expect(entries.map((e) => [e.service, e.outcome])).toEqual([
      ["ledger", "ok"],
      ["ledger", "invalid_token"],
      ["ledger", "no_bearer"],
    ]);
    expect(entries[0]).toMatchObject({
      sub: "auth0|log-user",
      aud: AUD.ledger,
      scope: "read:ledger",
      org_id: "org_123",
      act: { sub: "client-a" },
    });
    expect(entries[1]?.sub).toBeUndefined();
    const dump = JSON.stringify(downstreams.log);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("not.a.jwt");
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe("child process mode", () => {
  it("starts, serves a verified request, logs without the token and exits on SIGTERM", async () => {
    const entry = fileURLToPath(new URL("./downstream-server.mjs", import.meta.url));
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        DOWNSTREAM_JWKS_URI: jwksUri,
        DOWNSTREAM_ISSUER: ISSUER,
        DOWNSTREAM_AUD_ORDERS: AUD.orders,
        DOWNSTREAM_AUD_INVENTORY: AUD.inventory,
        DOWNSTREAM_AUD_ANALYTICS: AUD.analytics,
        DOWNSTREAM_AUD_LEDGER: AUD.ledger,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: Array<Record<string, unknown>> = [];
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        lines.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`child did not produce output in time. stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      await waitFor(() => lines.some((l) => l["event"] === "listening"));
      const listening = lines.find((l) => l["event"] === "listening") as { urls: Record<string, string> };
      const token = await sign({ aud: AUD.analytics, scope: "read:analytics" });
      const ok = await get(`${listening.urls["analytics"]}/analytics/monthly-revenue`, token);
      expect(ok.status).toBe(200);
      const denied = await get(`${listening.urls["orders"]}/orders`, token);
      expect(denied.status).toBe(401);
      await waitFor(() => lines.filter((l) => l["event"] === "request").length >= 2);
      const requests = lines.filter((l) => l["event"] === "request");
      expect(requests.map((r) => [r["service"], r["outcome"]])).toEqual([
        ["analytics", "ok"],
        ["orders", "invalid_token"],
      ]);
      expect(JSON.stringify(lines)).not.toContain(token);
    } finally {
      child.kill("SIGTERM");
    }
    const result = await exited;
    expect(result.code).toBe(0);
  }, 30_000);
});
