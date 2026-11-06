import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, decodeJwt, createLocalJWKSet, jwtVerify } from "jose";
import { setupServer } from "msw/node";
import {
  TOKEN_EXCHANGE_GRANT,
  createAuth0Handlers,
  createDownstreamOracle,
  createTestKey,
  exportJwks,
  mintAccessToken,
  mintUnsignedToken,
  scopeMode,
} from "./index.js";
import type { TestKey } from "./index.js";

const DOWNSTREAM = "https://downstream.example.com/resource";
const AUDIENCE = "https://api.example.com";

let key: TestKey;
let otherKey: TestKey;
let ctx: ReturnType<typeof createAuth0Handlers>;
const server = setupServer();

beforeAll(async () => {
  key = await createTestKey();
  otherKey = await createTestKey();
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function use(options: Partial<Parameters<typeof createAuth0Handlers>[0]> = {}) {
  ctx = createAuth0Handlers({ key, ...options });
  server.use(...ctx.handlers);
  return ctx;
}

function post(params: Record<string, string>) {
  return fetch(ctx.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

async function exchange(extra: Record<string, string> = {}) {
  const subject = await mintAccessToken(key, { sub: "user|42", aud: "https://mcp.example.com" });
  return post({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subject,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience: AUDIENCE,
    client_id: "client-a",
    ...extra,
  });
}

describe("auth0 handlers", () => {
  it("serves discovery and a JWKS that verifies minted tokens", async () => {
    use();
    const discovery = await (
      await fetch("https://tenant.example.com/.well-known/openid-configuration")
    ).json();
    expect(discovery.issuer).toBe("https://tenant.example.com/");
    expect(discovery.token_endpoint).toBe(ctx.tokenEndpoint);

    const jwks = await (await fetch(discovery.jwks_uri)).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe(key.kid);
    expect(jwks.keys[0].d).toBeUndefined();

    const token = await mintAccessToken(key, { aud: AUDIENCE });
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { audience: AUDIENCE });
    expect(payload.sub).toBe("user|1");
  });

  it("counts only token-exchange requests as exchanges", async () => {
    use();
    await post({ grant_type: "client_credentials", client_id: "m2m", audience: AUDIENCE });
    expect(ctx.state.exchangeCount).toBe(0);
    expect(ctx.state.clientCredentialsCount).toBe(1);

    await exchange();
    await exchange();
    expect(ctx.state.exchangeCount).toBe(2);
    expect(ctx.state.clientCredentialsCount).toBe(1);
    expect(ctx.state.requests).toHaveLength(3);
    expect(ctx.state.lastExchangeRequest?.params["audience"]).toBe(AUDIENCE);
  });

  it("issues a verifiable JWT bound to the requested audience and subject", async () => {
    use();
    const body = await (await exchange({ scope: "read:a read:b" })).json();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    const claims = decodeJwt(body.access_token);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.sub).toBe("user|42");
    expect(claims.iss).toBe("https://tenant.example.com/");
    expect(claims["scope"]).toBe("read:a read:b");
  });

  it("echoes the requested scope", async () => {
    use({ scope: scopeMode.echo });
    const body = await (await exchange({ scope: "read:a" })).json();
    expect(body.scope).toBe("read:a");
  });

  it("returns a fixed granted scope regardless of the request", async () => {
    use({ scope: scopeMode.fixed("read:only") });
    const body = await (await exchange({ scope: "read:a write:a" })).json();
    expect(body.scope).toBe("read:only");
    expect(decodeJwt(body.access_token)["scope"]).toBe("read:only");
  });

  it("omits scope entirely in absent mode", async () => {
    use({ scope: scopeMode.absent });
    const body = await (await exchange({ scope: "read:a" })).json();
    expect("scope" in body).toBe(false);
    expect("scope" in decodeJwt(body.access_token)).toBe(false);
  });

  it("returns an empty scope string in empty mode", async () => {
    use({ scope: scopeMode.empty });
    const body = await (await exchange({ scope: "read:a" })).json();
    expect(body.scope).toBe("");
  });

  it("honours a configurable expires_in", async () => {
    use({ expiresIn: 30 });
    const body = await (await exchange()).json();
    expect(body.expires_in).toBe(30);
    const claims = decodeJwt(body.access_token);
    expect(claims.exp! - claims.iat!).toBe(30);
  });

  it("returns the configured failure for exchanges only", async () => {
    use({ failure: { status: 403, body: { error: "access_denied", error_description: "no" } } });
    const res = await exchange();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "access_denied", error_description: "no" });
    expect(ctx.state.exchangeCount).toBe(1);

    const cc = await post({ grant_type: "client_credentials", client_id: "m2m" });
    expect(cc.status).toBe(200);
  });

  it("can fail client_credentials requests", async () => {
    use({ failure: { status: 500, grant: "client_credentials" } });
    const cc = await post({ grant_type: "client_credentials", client_id: "m2m" });
    expect(cc.status).toBe(500);
    expect((await exchange()).status).toBe(200);
  });

  it("counts all received exchanges but only successful ones as successful", async () => {
    use({ failure: { status: 503 } });
    await exchange();
    expect(ctx.state.exchangeCount).toBe(1);
    expect(ctx.state.successfulExchangeCount).toBe(0);

    ctx.state.failure = null;
    await exchange();
    await post({ grant_type: TOKEN_EXCHANGE_GRANT, client_id: "client-a" });
    expect(ctx.state.exchangeCount).toBe(3);
    expect(ctx.state.successfulExchangeCount).toBe(1);
  });

  it("requires subject_token and subject_token_type on exchange", async () => {
    use();
    const noSubject = await post({ grant_type: TOKEN_EXCHANGE_GRANT, client_id: "c" });
    expect(noSubject.status).toBe(400);
    expect((await noSubject.json()).error).toBe("invalid_request");

    const subject = await mintAccessToken(key, {});
    const noType = await post({
      grant_type: TOKEN_EXCHANGE_GRANT,
      client_id: "c",
      subject_token: subject,
    });
    expect(noType.status).toBe(400);
    expect((await noType.json()).error).toBe("invalid_request");
  });

  it("requires client_id on both grants", async () => {
    use();
    const subject = await mintAccessToken(key, {});
    const ex = await post({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subject,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
    expect(ex.status).toBe(400);
    expect((await ex.json()).error).toBe("invalid_request");

    const cc = await post({ grant_type: "client_credentials" });
    expect(cc.status).toBe(400);
    expect((await cc.json()).error).toBe("invalid_request");
  });

  it("accepts client credentials from an HTTP Basic header", async () => {
    use();
    const basic = Buffer.from("basic-client:secret").toString("base64");
    const res = await fetch(ctx.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    expect(res.status).toBe(200);
    expect(ctx.state.lastClientCredentialsRequest?.clientId).toBe("basic-client");
    expect(decodeJwt((await res.json()).access_token)["client_id"]).toBe("basic-client");
  });

  it("rejects subject tokens with a bad signature or issuer as invalid_grant", async () => {
    use();
    const forged = await mintAccessToken(otherKey, {});
    const wrongIssuer = await mintAccessToken(key, { iss: "https://evil.example.com/" });
    for (const subject_token of [forged, wrongIssuer, "not-a-jwt"]) {
      const res = await exchange({ subject_token });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    }
    expect(ctx.state.successfulExchangeCount).toBe(0);
  });

  it("copies org_id from the subject token to the issued token", async () => {
    use();
    const subject = await mintAccessToken(key, { claims: { org_id: "org_123" } });
    const body = await (await exchange({ subject_token: subject })).json();
    expect(decodeJwt(body.access_token)["org_id"]).toBe("org_123");

    const plain = await (await exchange()).json();
    expect("org_id" in decodeJwt(plain.access_token)).toBe(false);
  });

  it("rejects unsupported grants", async () => {
    use();
    const res = await post({ grant_type: "password" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });

  it("reset restores counters, recordings and configuration", async () => {
    use({ scope: scopeMode.absent });
    await exchange();
    ctx.state.scope = scopeMode.empty;
    ctx.state.failure = { status: 500 };
    ctx.state.reset();
    expect(ctx.state.exchangeCount).toBe(0);
    expect(ctx.state.requests).toHaveLength(0);
    expect(ctx.state.lastExchangeRequest).toBeNull();
    expect(ctx.state.failure).toBeNull();
    expect(ctx.state.scope).toEqual(scopeMode.absent);
  });
});

describe("downstream oracle", () => {
  const issuer = "https://tenant.example.com/";
  const oracle = () =>
    createDownstreamOracle({
      jwks: exportJwks(key),
      issuer,
      audience: AUDIENCE,
      requiredScope: "work:read",
    });
  const valid = (over = {}) =>
    mintAccessToken(key, { iss: issuer, aud: AUDIENCE, scope: "work:read other", ...over });

  it("accepts a valid token with or without the Bearer prefix", async () => {
    const o = oracle();
    const token = await valid();
    const a = await o.verify(`Bearer ${token}`);
    const b = await o.verify(token);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) expect(a.scopes).toEqual(["work:read", "other"]);
  });

  it("rejects a wrong audience", async () => {
    const v = await oracle().verify(await valid({ aud: "https://other.example.com" }));
    expect(v).toMatchObject({ ok: false, status: 401, reason: "wrong_audience" });
  });

  it("rejects a wrong issuer", async () => {
    const v = await oracle().verify(await valid({ iss: "https://evil.example.com/" }));
    expect(v).toMatchObject({ ok: false, status: 401, reason: "wrong_issuer" });
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const v = await oracle().verify(await valid({ exp: past, iat: past - 60 }));
    expect(v).toMatchObject({ ok: false, status: 401, reason: "expired" });
  });

  it("rejects a token signed by another key", async () => {
    const sameKid = { ...otherKey, kid: key.kid };
    const token = await mintAccessToken(sameKid, { iss: issuer, aud: AUDIENCE, scope: "work:read" });
    const v = await oracle().verify(token);
    expect(v).toMatchObject({ ok: false, status: 401, reason: "bad_signature" });
  });

  it("rejects a token with an unknown key id", async () => {
    const token = await mintAccessToken(otherKey, { iss: issuer, aud: AUDIENCE, scope: "work:read" });
    const v = await oracle().verify(token);
    expect(v).toMatchObject({ ok: false, status: 401, reason: "bad_signature" });
  });

  it("rejects alg none tokens", async () => {
    const token = mintUnsignedToken({ iss: issuer, aud: AUDIENCE, scope: "work:read" });
    const v = await oracle().verify(token);
    expect(v).toMatchObject({ ok: false, status: 401, reason: "bad_signature" });
  });

  it("rejects an HS256 token signed with the RSA public key material", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
    const token = await new SignJWT({ iss: issuer, aud: AUDIENCE, sub: "u", scope: "work:read" })
      .setProtectedHeader({ alg: "HS256", kid: key.kid })
      .setExpirationTime("1h")
      .sign(secret);
    const v = await oracle().verify(token);
    expect(v).toMatchObject({ ok: false, status: 401, reason: "bad_signature" });
  });

  it("rejects tokens missing exp or sub", async () => {
    const o = oracle();
    expect((await o.verify(await valid({ exp: false }))).ok).toBe(false);
    expect((await o.verify(await valid({ sub: false }))).ok).toBe(false);
  });

  it("rejects tokens missing aud or iss", async () => {
    const o = oracle();
    expect(await o.verify(await valid({ aud: false }))).toMatchObject({
      ok: false,
      reason: "wrong_audience",
    });
    expect(await o.verify(await valid({ iss: false }))).toMatchObject({
      ok: false,
      reason: "wrong_issuer",
    });
  });

  it("reads scope from scp as a string or array and tolerates extra whitespace", async () => {
    const o = oracle();
    const asString = await o.verify(await valid({ scope: undefined, claims: { scp: "a  work:read" } }));
    const asArray = await o.verify(await valid({ scope: undefined, claims: { scp: ["work:read"] } }));
    const spaced = await o.verify(await valid({ scope: "a\twork:read\n" }));
    expect(asString.ok && asString.scopes).toEqual(["a", "work:read"]);
    expect(asArray.ok).toBe(true);
    expect(spaced.ok).toBe(true);
  });

  it("handler requires a strict Bearer Authorization header", async () => {
    const o = oracle();
    server.use(o.handler(DOWNSTREAM));
    const token = await valid();
    const call = async (authorization?: string) => {
      const res = await fetch(DOWNSTREAM, authorization ? { headers: { authorization } } : {});
      return { status: res.status, body: await res.json() };
    };
    expect((await call(token)).body.reason).toBe("malformed");
    expect((await call(`Basic ${token}`)).body.reason).toBe("malformed");
    expect((await call(`Bearer  ${token} extra`)).body.reason).toBe("malformed");
    expect((await call("Bearer")).body.reason).toBe("missing_token");
    expect((await call()).body.reason).toBe("missing_token");
    expect((await call(`Bearer ${token}`)).status).toBe(200);
  });

  it("rejects a missing scope with 403", async () => {
    const v = await oracle().verify(await valid({ scope: "other" }));
    expect(v).toMatchObject({ ok: false, status: 403, reason: "missing_scope" });
  });

  it("rejects missing and malformed tokens", async () => {
    const o = oracle();
    expect(await o.verify(undefined)).toMatchObject({ ok: false, reason: "missing_token" });
    expect(await o.verify("Bearer not-a-jwt")).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("accepts a token issued by the auth0 handlers", async () => {
    use({ scope: scopeMode.fixed("work:read") });
    const body = await (await exchange()).json();
    const v = await oracle().verify(`Bearer ${body.access_token}`);
    expect(v.ok).toBe(true);
  });

  it("works as an MSW handler and records calls", async () => {
    const o = oracle();
    server.use(o.handler(DOWNSTREAM));
    const ok = await fetch(DOWNSTREAM, { headers: { authorization: `Bearer ${await valid()}` } });
    expect(ok.status).toBe(200);
    const denied = await fetch(DOWNSTREAM, {
      headers: { authorization: `Bearer ${await valid({ scope: "other" })}` },
    });
    expect(denied.status).toBe(403);
    const missing = await fetch(DOWNSTREAM);
    expect(missing.status).toBe(401);
    expect(o.calls).toHaveLength(3);
    o.reset();
    expect(o.calls).toHaveLength(0);
  });
});

describe("token minting", () => {
  it("writes configurable claims and header, and can omit each registered claim", async () => {
    const token = await mintAccessToken(key, {
      iss: "https://issuer.example.test/",
      aud: ["a", "b"],
      sub: "user|7",
      scope: "",
      jti: "jti-1",
      claims: { azp: "client-x", client_id: "client-x", sid: "sid-1", org_id: "org_9" },
      header: { kid: "other-kid" },
    });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      iss: "https://issuer.example.test/",
      aud: ["a", "b"],
      sub: "user|7",
      scope: "",
      jti: "jti-1",
      azp: "client-x",
      client_id: "client-x",
      sid: "sid-1",
      org_id: "org_9",
    });
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).kid).toBe("other-kid");

    const bare = decodeJwt(
      await mintAccessToken(key, { iss: false, aud: false, sub: false, exp: false, iat: false })
    );
    expect(Object.keys(bare)).toEqual([]);
    expect("scope" in decodeJwt(await mintAccessToken(key))).toBe(false);
  });
});
