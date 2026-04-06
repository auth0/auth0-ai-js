/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";

import { AsyncAuthorizerBase } from "@auth0/ai/AsyncAuthorization";
import {
  AsyncAuthorizationInterrupt,
  AuthorizationPendingInterrupt,
  AuthorizationRequestExpiredInterrupt,
} from "@auth0/ai/interrupts";

import { AsyncAuthorizer } from "../src/AsyncAuthorization";
import { setAIContext } from "../src/context";

describe("AsyncAuthorizer", () => {
  let authorizer: AsyncAuthorizer;
  let mockTool: Tool;
  let protectedTool: Tool;
  const authorizerParameters = {
    userID: (params: { userID: string }) => params.userID,
    bindingMessage: "Confirm the purchase",
    scopes: ["openid", "stock:trade"],
    audience: "http://localhost:8081",

    store: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };

  beforeEach(() => {
    authorizer = new AsyncAuthorizer(
      {
        clientId: "client-id",
        clientSecret: "client",
        domain: "test",
      },
      authorizerParameters
    );

    mockTool = {
      description: "A mock tool for testing",
      inputSchema: z.object({
        userID: z.string(),
        input: z.string(),
      }),
      execute: vi.fn().mockResolvedValue({ result: "success" }),
    };

    protectedTool = authorizer.authorizer()(mockTool);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("on authorization pending error", () => {
    let error: AsyncAuthorizationInterrupt;
    beforeEach(async () => {
      authorizerParameters.store.get.mockImplementation((ns, k) =>
        k === "authResponse"
          ? {
              status: "pending",
            }
          : undefined
      );

      vi.spyOn(
        AsyncAuthorizerBase.prototype,
        //@ts-ignore
        "getCredentials"
      ).mockImplementation(() => {
        throw new AuthorizationPendingInterrupt("Authorization pending", {
          interval: 10,
          id: "123",
          requestedAt: Date.now(),
          expiresIn: 10,
        });
      });

      try {
        setAIContext({ threadID: "123" });
        await protectedTool!.execute!(
          { userID: "user1", input: "input" },
          { toolCallId: "test-call-id", messages: [] }
        );
      } catch (err) {
        error = err as AsyncAuthorizationInterrupt;
      }
    });

    it("should throw a CIBA interrupt", () => {
      expect(error).toBeInstanceOf(AsyncAuthorizationInterrupt);
    });

    it("should not call the tool execute method", () => {
      expect(mockTool.execute).not.toHaveBeenCalled();
    });
  });

  describe("on authorization request expired error", () => {
    let error: AsyncAuthorizationInterrupt;
    let result: {
      name: string;
      code: string;
      message: string;
      request: {
        interval: number;
        id: string;
        requestedAt: number;
        expiresIn: number;
      };
    };
    beforeEach(async () => {
      authorizerParameters.store.get.mockImplementation((ns, k) =>
        k === "authResponse"
          ? {
              status: "pending",
            }
          : undefined
      );

      vi.spyOn(
        AsyncAuthorizerBase.prototype,
        //@ts-ignore
        "getCredentials"
      ).mockImplementation(() => {
        throw new AuthorizationRequestExpiredInterrupt(
          "Authorization request expired",
          {
            interval: 10,
            id: "123",
            requestedAt: Date.now(),
            expiresIn: 10,
          }
        );
      });

      try {
        setAIContext({ threadID: "123" });
        result = await protectedTool!.execute!(
          { userID: "user1", input: "input" },
          { toolCallId: "test-call-id", messages: [] }
        );
      } catch (err) {
        error = err as AsyncAuthorizationInterrupt;
      }
    });

    it("should not throw an interrupt", () => {
      expect(error).toBeUndefined();
    });

    it("should return the result", () => {
      expect(result.name).toBe("AUTH0_AI_INTERRUPT");
      expect(result.code).toBe("ASYNC_AUTHORIZATION_AUTHORIZATION_REQUEST_EXPIRED");
      expect(result.message).toBe("Authorization request expired");
      expect(result.request).toMatchObject({
        interval: 10,
        id: "123",
        requestedAt: expect.any(Number),
        expiresIn: 10,
      });
    });

    it("should not call the tool execute method", () => {
      expect(mockTool.execute).not.toHaveBeenCalled();
    });
  });

  describe("on completed authorization request", () => {
    let error: AsyncAuthorizationInterrupt;
    beforeEach(async () => {
      authorizerParameters.store.get.mockImplementation((ns, k) =>
        k === "authResponse"
          ? {
              status: "pending",
            }
          : undefined
      );

      vi.spyOn(
        AsyncAuthorizerBase.prototype,
        //@ts-ignore
        "getCredentials"
        //@ts-ignore
      ).mockImplementation(() => {
        return {
          accessToken: {
            type: "bearer",
            value: "foobr",
          },
        };
      });

      try {
        setAIContext({ threadID: "123" });
        await protectedTool!.execute!(
          { userID: "user1", input: "input" },
          { toolCallId: "test-call-id", messages: [] }
        );
      } catch (err) {
        error = err as AsyncAuthorizationInterrupt;
      }
    });

    it("should not throw an error", () => {
      expect(error).toBeUndefined();
    });

    it("should call the tool execute method", () => {
      expect(mockTool.execute).toHaveBeenCalledOnce();
    });
  });
});
