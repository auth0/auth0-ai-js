import { InvalidConfigurationError, createMcpClient } from "@auth0/ai-mcp";
import { describe, expect, it } from "vitest";
import {
  assertRealm,
  assertSessionBinding,
  bearerOnly,
  resolveClient,
  resolveEndpoint,
  resolveMetadataUrl,
} from "../src/options.js";
import { AUDIENCE, principalOf, stubClient, withEnv } from "./support/stubs.js";

const ENV = {
  AUTH0_DOMAIN: "env-tenant.example.com",
  AUTH0_AUDIENCE: "https://env.example.com/mcp",
  AUTH0_CLIENT_ID: "env-client",
  AUTH0_CLIENT_SECRET: "env-secret",
};

describe("resolveClient", () => {
  it("returns the given client unchanged", () => {
    const client = stubClient();
    const resolved = resolveClient({ client });
    expect(resolved.client).toBe(client);
  });

  it("splits the adapter options from the client options", () => {
    const client = stubClient();
    const { rest } = resolveClient({ client, endpoint: "/api/mcp", realm: "orders", requiredScopes: ["a"] });
    expect(rest).toEqual({ endpoint: "/api/mcp", realm: "orders", requiredScopes: ["a"] });
    expect(rest).not.toHaveProperty("client");
  });

  it("rejects a client combined with an inline client option and names only the option", () => {
    const client = stubClient();
    const attempt = () =>
      resolveClient({ client, domain: "secret-tenant.example.com", clientSecret: "super-secret" } as never);
    expect(attempt).toThrow(InvalidConfigurationError);
    expect(attempt).toThrow(/"domain", "clientSecret"/);
    expect(attempt).not.toThrow(/secret-tenant|super-secret/);
  });

  it("builds a client from inline options", async () => {
    const { client } = await withEnv(
      { AUTH0_DOMAIN: undefined, AUTH0_AUDIENCE: undefined, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: undefined },
      () => resolveClient({ domain: "inline.example.com", audience: "https://inline.example.com/mcp" }),
    );
    expect(client.domain).toBe("inline.example.com");
    expect(client.audience).toBe("https://inline.example.com/mcp");
    expect(client.dpopMode).toBe("allowed");
  });

  it("completes a partial inline set from the environment", async () => {
    const { client } = await withEnv(ENV, () => resolveClient({ domain: "inline.example.com" }));
    expect(client.domain).toBe("inline.example.com");
    expect(client.audience).toBe(ENV.AUTH0_AUDIENCE);
  });

  it("reads everything from the environment when nothing is configured", async () => {
    const { client } = await withEnv(ENV, () => resolveClient({}));
    expect(client.domain).toBe(ENV.AUTH0_DOMAIN);
    expect(client.audience).toBe(ENV.AUTH0_AUDIENCE);
  });

  it("names the missing option and its variable, never a value, when the environment is empty", async () => {
    const attempt = () =>
      withEnv(
        { AUTH0_DOMAIN: undefined, AUTH0_AUDIENCE: undefined, AUTH0_CLIENT_ID: undefined, AUTH0_CLIENT_SECRET: "s3cret" },
        () => resolveClient({}),
      );
    await expect(attempt()).rejects.toThrow(/"domain".*AUTH0_DOMAIN/);
    await expect(attempt()).rejects.not.toThrow(/s3cret/);
  });

  it("passes inline client options such as dpop through to the client", async () => {
    const { client } = await withEnv(ENV, () => resolveClient({ dpop: { mode: "disabled" } }));
    expect(client.dpopMode).toBe("disabled");
  });
});

describe("bearerOnly", () => {
  it("reports DPoP as disabled whatever the client mode is", () => {
    expect(bearerOnly(stubClient({ dpopMode: "allowed" })).dpopMode).toBe("disabled");
    expect(bearerOnly(stubClient({ dpopMode: "disabled" })).dpopMode).toBe("disabled");
  });

  it("refuses a client that requires DPoP", () => {
    expect(() => bearerOnly(stubClient({ dpopMode: "required" }))).toThrow(InvalidConfigurationError);
    expect(() => bearerOnly(stubClient({ dpopMode: "required" }))).toThrow(/DPoP mode "required"/);
  });

  it("keeps the domain and audience", () => {
    const view = bearerOnly(stubClient({ audience: "https://a.example.com/mcp", domain: "d.example.com" }));
    expect(view.audience).toBe("https://a.example.com/mcp");
    expect(view.domain).toBe("d.example.com");
  });

  it("delegates verification and token binding to the real client", async () => {
    const inner = stubClient();
    const view = bearerOnly(inner);
    const caller = await view.verifyAccessToken({ accessToken: "t", scheme: "bearer" });
    expect(inner.verifyCalls).toEqual([{ accessToken: "t", scheme: "bearer" }]);
    expect(view.withToken(caller).getPrincipal()).toEqual(principalOf());
  });

  it("is frozen", () => {
    expect(Object.isFrozen(bearerOnly(stubClient()))).toBe(true);
  });

  it("works with a real client built by createMcpClient", () => {
    const real = createMcpClient({ domain: "tenant.example.com", audience: AUDIENCE });
    expect(bearerOnly(real).dpopMode).toBe("disabled");
    const required = createMcpClient({ domain: "tenant.example.com", audience: AUDIENCE, dpop: { mode: "required" } });
    expect(() => bearerOnly(required)).toThrow(InvalidConfigurationError);
  });
});

describe("resolveEndpoint", () => {
  it("defaults to /mcp", () => {
    expect(resolveEndpoint(undefined)).toBe("/mcp");
  });

  it("accepts a normalized absolute path", () => {
    expect(resolveEndpoint("/api/mcp")).toBe("/api/mcp");
  });

  it.each(["mcp", "/", "/mcp/", "/mcp?x=1", "/mcp#top", "/a/../mcp", "/a b", "", "//host/mcp"])(
    "rejects %j",
    (value) => {
      expect(() => resolveEndpoint(value)).toThrow(InvalidConfigurationError);
      expect(() => resolveEndpoint(value)).toThrow(/"endpoint"/);
    },
  );
});

describe("resolveMetadataUrl", () => {
  it("uses the suffixed well-known route when the resource path is the endpoint", () => {
    expect(resolveMetadataUrl("https://mcp.example.com/mcp", "/mcp")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("uses the root well-known route for a resource without a path", () => {
    expect(resolveMetadataUrl("https://mcp.example.com", "/mcp")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
    expect(resolveMetadataUrl("https://mcp.example.com/", "/mcp")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("ignores a trailing slash on the resource path", () => {
    expect(resolveMetadataUrl("https://mcp.example.com/mcp/", "/mcp")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("keeps the port of the resource", () => {
    expect(resolveMetadataUrl("http://127.0.0.1:4000/api/mcp", "/api/mcp")).toBe(
      "http://127.0.0.1:4000/.well-known/oauth-protected-resource/api/mcp",
    );
  });

  it("refuses a resource path that FastMCP would not serve the metadata for", () => {
    expect(() => resolveMetadataUrl("https://mcp.example.com/other", "/mcp")).toThrow(InvalidConfigurationError);
    expect(() => resolveMetadataUrl("https://mcp.example.com/other", "/mcp")).toThrow(/"endpoint"/);
  });
});

describe("assertRealm", () => {
  it("accepts a plain realm and an absent one", () => {
    expect(() => assertRealm("orders api")).not.toThrow();
    expect(() => assertRealm(undefined)).not.toThrow();
  });

  it.each(["", "   ", 'a"b', "a\\b", "a\nb", "café"])("rejects %j", (value) => {
    expect(() => assertRealm(value)).toThrow(InvalidConfigurationError);
  });
});

describe("assertSessionBinding", () => {
  it("accepts false, undefined and sane limits", () => {
    expect(() => assertSessionBinding(false)).not.toThrow();
    expect(() => assertSessionBinding(undefined)).not.toThrow();
    expect(() => assertSessionBinding({})).not.toThrow();
    expect(() => assertSessionBinding({ maxSessions: 10, ttlMs: 1000 })).not.toThrow();
  });

  it.each([
    [{ maxSessions: 0 }],
    [{ maxSessions: -1 }],
    [{ ttlMs: 0 }],
    [{ ttlMs: Number.NaN }],
    [{ ttlMs: Number.POSITIVE_INFINITY }],
    [{ maxSessions: "10" as unknown as number }],
  ])("rejects %j", (value) => {
    expect(() => assertSessionBinding(value)).toThrow(InvalidConfigurationError);
  });
});
