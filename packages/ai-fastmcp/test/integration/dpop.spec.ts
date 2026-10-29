import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { INITIALIZE_BODY, connect, createRig, parseChallenge, rawRequest, withServer } from "./harness.js";

const rig = createRig({ beforeAll, afterEach, afterAll });

const MODES = [{ stateless: true }, { stateless: false }];
const PROOF = "eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJqdGkiOiJ4In0.c2ln";

function metadataUrlOf(server: { origin: string; endpoint: string }): string {
  return `${server.origin}/.well-known/oauth-protected-resource${server.endpoint}`;
}

describe.each(MODES)("DPoP is refused (stateless: $stateless)", ({ stateless }) => {
  describe("a request that carries a DPoP header", () => {
    it("is refused with 401 and a Bearer challenge, even with a valid Bearer token", async () => {
      await withServer({ stateless }, async (server) => {
        const token = await rig().token(server);
        const response = await rawRequest(server, {
          body: INITIALIZE_BODY,
          headers: { authorization: `Bearer ${token}`, dpop: PROOF },
        });
        expect(response.status).toBe(401);
        const challenge = parseChallenge(response.headers.get("www-authenticate"));
        expect(challenge.scheme).toBe("Bearer");
        expect(challenge.params["error"]).toBe("invalid_token");
        expect(challenge.params["error_description"]).toBe("DPoP is not supported by this server.");
        expect(challenge.params["resource_metadata"]).toBe(metadataUrlOf(server));
        expect(await response.json()).toEqual({
          error: "invalid_token",
          error_description: "DPoP is not supported by this server.",
        });
        // The token was never used: nothing was fetched from the tenant.
        expect(rig().requests).toEqual([]);
      });
    });

    it("is refused for a real client that sends the header on every request", async () => {
      await withServer({ stateless }, async (server) => {
        const token = await rig().token(server);
        const failure = await connect(server, token, { dpop: PROOF }).then(
          () => undefined,
          (error: Error & { seen: Array<{ status: number }> }) => error,
        );
        expect(failure).toBeDefined();
        expect(failure!.seen[0]!.status).toBe(401);
      });
    });

    it("is refused with an empty header value", async () => {
      await withServer({ stateless }, async (server) => {
        const token = await rig().token(server);
        const response = await rawRequest(server, {
          body: INITIALIZE_BODY,
          headers: { authorization: `Bearer ${token}`, dpop: "" },
        });
        expect(response.status).toBe(401);
      });
    });

    it("is refused when there is no Authorization header at all", async () => {
      await withServer({ stateless }, async (server) => {
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { dpop: PROOF } });
        expect(response.status).toBe(401);
        expect(parseChallenge(response.headers.get("www-authenticate")).params["error_description"]).toBe(
          "DPoP is not supported by this server.",
        );
      });
    });

    it("is refused with the DPoP authorization scheme", async () => {
      await withServer({ stateless }, async (server) => {
        const token = await rig().token(server, { claims: { cnf: { jkt: "thumbprint" } } });
        const response = await rawRequest(server, {
          body: INITIALIZE_BODY,
          headers: { authorization: `DPoP ${token}`, dpop: PROOF },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
        expect(response.headers.get("www-authenticate")).not.toMatch(/DPoP (algs|error)/);
      });
    });

    it("treats the DPoP scheme without a proof header as no credential", async () => {
      await withServer({ stateless }, async (server) => {
        const token = await rig().token(server, { claims: { cnf: { jkt: "thumbprint" } } });
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `DPoP ${token}` } });
        expect(response.status).toBe(401);
        expect(parseChallenge(response.headers.get("www-authenticate")).params["error"]).toBeUndefined();
      });
    });
  });

  describe("a DPoP-bound token sent as a Bearer token", () => {
    const bound = { cnf: { jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" } };

    it("is refused with 401", async () => {
      await withServer({ stateless }, async (server) => {
        const token = await rig().token(server, { claims: bound });
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(401);
        const challenge = parseChallenge(response.headers.get("www-authenticate"));
        expect(challenge.scheme).toBe("Bearer");
        expect(challenge.params["error"]).toBe("invalid_token");
        expect(response.headers.get("www-authenticate")).not.toContain("algs=");
        await expect(connect(server, token)).rejects.toBeDefined();
        expect(rig().requests).toEqual([]);
      });
    });

    it("is still refused when the client is configured with DPoP disabled", async () => {
      await withServer({ stateless, clientOptions: { dpop: { mode: "disabled" } } }, async (server) => {
        const token = await rig().token(server, { claims: bound });
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(401);
        expect(parseChallenge(response.headers.get("www-authenticate")).params["error_description"]).toBe(
          "DPoP-bound access tokens are not supported by this server.",
        );
        await expect(connect(server, token)).rejects.toBeDefined();
      });
    });

    it("is refused when the binding is a mutual TLS thumbprint", async () => {
      await withServer({ stateless, clientOptions: { dpop: { mode: "disabled" } } }, async (server) => {
        const token = await rig().token(server, { claims: { cnf: { "x5t#S256": "thumbprint" } } });
        const response = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(401);
      });
    });

    it("does not stop an unbound token from working", async () => {
      await withServer({ stateless, clientOptions: { dpop: { mode: "disabled" } } }, async (server) => {
        const session = await connect(server, await rig().token(server));
        await session.close();
      });
    });
  });

  describe("the client configuration", () => {
    it("never advertises DPoP in a challenge, whatever the DPoP mode of the client", async () => {
      for (const mode of ["allowed", "disabled"] as const) {
        await withServer({ stateless, clientOptions: { dpop: { mode } } }, async (server) => {
          const response = await rawRequest(server, { body: INITIALIZE_BODY });
          expect(response.headers.get("www-authenticate")).not.toMatch(/dpop/i);
          const bad = await rawRequest(server, { body: INITIALIZE_BODY, headers: { authorization: "Bearer not-a-jwt" } });
          expect(bad.headers.get("www-authenticate")).not.toMatch(/dpop/i);
        });
      }
    });
  });
});
