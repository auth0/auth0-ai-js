import { beforeEach, describe, expect, it } from "vitest";

import {
  AsyncAuthorizationInterrupt,
  Auth0Interrupt,
  AuthorizationRequestExpiredInterrupt,
  TokenVaultInterrupt,
} from "../src/interrupts";

describe("interrupts", () => {
  it("should properly assert is an auth0interrupt", () => {
    const auth0Interrupt = { name: "AUTH0_AI_INTERRUPT" };
    expect(Auth0Interrupt.isInterrupt(auth0Interrupt)).toBe(true);
  });

  it("should properly assert not an interrupt", () => {
    const auth0Interrupt = { name: "FOO" };
    expect(Auth0Interrupt.isInterrupt(auth0Interrupt)).toBe(false);
  });

  describe("TokenVaultInterrupt", () => {
    let interrupt: TokenVaultInterrupt;
    let serialized: any;
    beforeEach(() => {
      interrupt = new TokenVaultInterrupt("this is a message", {
        connection: "google-oauth2",
        scopes: ["email"],
        requiredScopes: ["email"],
      });
      serialized = interrupt.toJSON();
    });

    it("should contain the interrupt options", () => {
      expect(serialized).toMatchInlineSnapshot(`
        {
          "authorizationParams": {},
          "behavior": "resume",
          "code": "TOKEN_VAULT_ERROR",
          "connection": "google-oauth2",
          "message": "this is a message",
          "name": "AUTH0_AI_INTERRUPT",
          "requiredScopes": [
            "email",
          ],
          "scopes": [
            "email",
          ],
        }
      `);
    });

    it("should properly assert the serialized version", () => {
      expect(TokenVaultInterrupt.isInterrupt(serialized)).toBe(true);
    });

    it("should properly assert the instance", () => {
      expect(TokenVaultInterrupt.isInterrupt(interrupt)).toBe(true);
    });

    it("should properly assert is an auth0interrupt", () => {
      expect(Auth0Interrupt.isInterrupt(interrupt)).toBe(true);
    });

    it("should create interrupt with default empty authorizationParams", () => {
      const interrupt = new TokenVaultInterrupt("test message", {
        connection: "custom",
        scopes: ["read:profile"],
        requiredScopes: ["read:profile", "write:profile"],
      });

      expect(interrupt.authorizationParams).toEqual({});
    });

    it("should create interrupt with custom authorizationParams", () => {
      const authParams = {
        audience: "https://api.example.com",
        prompt: "consent",
      };

      const interrupt = new TokenVaultInterrupt("test message", {
        connection: "custom",
        scopes: ["read:profile"],
        requiredScopes: ["read:profile", "write:profile"],
        authorizationParams: authParams,
        behavior: "resume",
      });

      expect(interrupt.authorizationParams).toEqual(authParams);
    });
  });

  describe("AsyncAuthorizationInterrupt", () => {
    let interrupt: AsyncAuthorizationInterrupt;
    let serialized: any;

    beforeEach(() => {
      interrupt = new AuthorizationRequestExpiredInterrupt(
        "The request has expired",
        {
          id: "123",
          requestedAt: 123,
          expiresIn: 123,
          interval: 123,
        },
      );
      serialized = interrupt.toJSON();
    });

    it("should contain the interrupt options", () => {
      expect(serialized).toMatchInlineSnapshot(`
        {
          "code": "ASYNC_AUTHORIZATION_AUTHORIZATION_REQUEST_EXPIRED",
          "message": "The request has expired",
          "name": "AUTH0_AI_INTERRUPT",
          "request": {
            "expiresIn": 123,
            "id": "123",
            "interval": 123,
            "requestedAt": 123,
          },
        }
      `);
    });

    it("should properly assert the serialized version with the base class", () => {
      expect(AsyncAuthorizationInterrupt.isInterrupt(serialized)).toBe(true);
    });

    it("should properly assert the instance with the base class", () => {
      expect(AsyncAuthorizationInterrupt.isInterrupt(interrupt)).toBe(true);
    });

    it("should properly assert the serialized version", () => {
      expect(AuthorizationRequestExpiredInterrupt.isInterrupt(serialized)).toBe(
        true,
      );
    });

    it("should properly assert the instance", () => {
      expect(AuthorizationRequestExpiredInterrupt.isInterrupt(interrupt)).toBe(
        true,
      );
    });

    it("should not match other interrupts", () => {
      expect(TokenVaultInterrupt.isInterrupt(interrupt)).toBe(false);
    });
  });
});
