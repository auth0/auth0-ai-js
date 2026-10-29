/**
 * A local "Work API". It verifies the bearer it receives against the tenant JWKS (issuer,
 * audience and RS256 enforced) and answers with the verified claims, so a spec can see exactly
 * what a real downstream API would see. The token itself is never echoed.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

export interface DownstreamCall {
  status: number;
  /** Verified claims when the token was accepted. */
  claims?: JWTPayload;
  /** Failure reason code when it was not. */
  reason?: string;
}

export interface DownstreamApi {
  /** Absolute URL to call, for example `http://127.0.0.1:1234/data`. */
  url: string;
  /** Every request seen, in order. */
  calls: DownstreamCall[];
  close(): Promise<void>;
}

/** Body of a 200 answer. */
export interface DownstreamClaimsBody {
  ok: true;
  claimNames: string[];
  sub?: string;
  aud?: string | string[];
  scope?: string;
  azp?: string;
  act?: { sub?: string; act?: { sub?: string } };
  org_id?: string;
}

export async function startDownstreamApi(options: { domain: string; audience: string }): Promise<DownstreamApi> {
  const issuer = `https://${options.domain}/`;
  const jwks = createRemoteJWKSet(new URL(`https://${options.domain}/.well-known/jwks.json`));
  const calls: DownstreamCall[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const header = req.headers.authorization ?? "";
      const token = /^Bearer (\S+)$/i.exec(header)?.[1];
      const reply = (status: number, body: unknown, call: DownstreamCall) => {
        calls.push(call);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (token === undefined) {
        reply(401, { ok: false, reason: "no_bearer" }, { status: 401, reason: "no_bearer" });
        return;
      }
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: options.audience,
          algorithms: ["RS256"],
        });
        const body: DownstreamClaimsBody = {
          ok: true,
          claimNames: Object.keys(payload).sort(),
          ...(payload.sub !== undefined && { sub: payload.sub }),
          ...(payload.aud !== undefined && { aud: payload.aud }),
          ...(typeof payload["scope"] === "string" && { scope: payload["scope"] }),
          ...(typeof payload["azp"] === "string" && { azp: payload["azp"] }),
          ...(payload["act"] !== undefined && { act: payload["act"] as DownstreamClaimsBody["act"] }),
          ...(typeof payload["org_id"] === "string" && { org_id: payload["org_id"] }),
        };
        reply(200, body, { status: 200, claims: payload });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "verify_failed";
        reply(401, { ok: false, reason }, { status: 401, reason });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/data`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
