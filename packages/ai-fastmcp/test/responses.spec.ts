import { describe, expect, it } from "vitest";
import { challengeResponse, genericServerError, jsonResponse, sessionMismatchResponse } from "../src/responses.js";

describe("responses", () => {
  it("builds a JSON response that is not cached", async () => {
    const response = jsonResponse(418, { a: 1 });
    expect(response.status).toBe(418);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ a: 1 });
  });

  it("keeps the headers it is given", () => {
    const headers = new Headers({ "x-extra": "1" });
    expect(jsonResponse(200, {}, headers).headers.get("x-extra")).toBe("1");
  });

  it("builds a generic server error that names no cause", async () => {
    const response = genericServerError();
    expect(response.status).toBe(500);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "server_error", error_description: "Internal server error." });
  });

  it("builds a Bearer challenge with the error, the description and the metadata URL", async () => {
    const response = challengeResponse({
      status: 401,
      error: "invalid_token",
      description: "Nope.",
      realm: "orders",
      metadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="orders", error="invalid_token", error_description="Nope.", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(await response.json()).toEqual({ error: "invalid_token", error_description: "Nope." });
  });

  it("omits the realm when none is set", () => {
    const response = challengeResponse({
      status: 401,
      error: "invalid_token",
      description: "Nope.",
      realm: undefined,
      metadataUrl: "https://mcp.example.com/m",
    });
    expect(response.headers.get("www-authenticate")).not.toContain("realm");
  });

  it("builds a session mismatch response without a challenge", async () => {
    const response = sessionMismatchResponse();
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: "forbidden",
      error_description: "The session belongs to a different caller.",
    });
  });
});
