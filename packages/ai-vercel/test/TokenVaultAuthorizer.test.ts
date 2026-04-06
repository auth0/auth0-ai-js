/* eslint-disable @typescript-eslint/ban-ts-comment */
import { Tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";

import { TokenVaultInterrupt } from "@auth0/ai/interrupts";
import { TokenVaultAuthorizerBase } from "@auth0/ai/TokenVault";

import { setAIContext } from "../src/context";
import { getCredentialsFromTokenVault, TokenVaultAuthorizer } from "../src/TokenVault";

describe("TokenVaultAuthorizer", () => {
  const mockTool = {
    description: "A mock tool for testing",
    inputSchema: z.object({
      userID: z.string(),
      input: z.string(),
    }),
    execute: vi.fn().mockResolvedValue({ result: "success" }),
  };
  const authorizerParameters = {
    connection: "test-connection",
    scopes: ["test-scope"],
    refreshToken: vi.fn(),
    store: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
  let authorizer: TokenVaultAuthorizer;
  let protectedTool: Tool;

  beforeEach(() => {
    authorizer = new TokenVaultAuthorizer(
      {
        clientId: "client-id",
        clientSecret: "client",
        domain: "test",
      },
      authorizerParameters
    );

    protectedTool = authorizer.authorizer()(mockTool);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("on TokenVaultInterrupt error", () => {
    let error: TokenVaultInterrupt;
    beforeEach(async () => {
      vi.spyOn(
        TokenVaultAuthorizerBase.prototype,
        //@ts-ignore
        "getAccessToken"
      ).mockImplementation(() => {
        throw new TokenVaultInterrupt("Authorization required", {
          connection: "test",
          scopes: ["test"],
          requiredScopes: ["test"],
        });
      });

      try {
        setAIContext({ threadID: "123" });
        await protectedTool!.execute!(
          { userID: "user1", input: "input" },
          { toolCallId: "test-call-id", messages: [] }
        );
      } catch (err) {
        error = err as TokenVaultInterrupt;
      }
    });

    it("should throw a token vault error", () => {
      expect(error).toBeInstanceOf(TokenVaultInterrupt);
    });

    it("should not call the tool execute", () => {
      expect(mockTool.execute).not.toHaveBeenCalled();
    });
  });

  describe("on authorization success", () => {
    let error: TokenVaultInterrupt;
    let accessToken: string | undefined;

    beforeEach(async () => {
      vi.spyOn(
        TokenVaultAuthorizerBase.prototype,
        //@ts-ignore
        "getAccessToken"
        //@ts-ignore
      ).mockImplementation(() => {
        return {
          accessToken: "access_token",
          scopes: ["test-scope"],
          type: "Bearer",
        };
      });

      try {
        setAIContext({ threadID: "123" });
        mockTool.execute.mockImplementation(() => {
          const credentials = getCredentialsFromTokenVault();
          accessToken = credentials?.accessToken;
          return { result: "success" };
        });
        await protectedTool!.execute!(
          { userID: "user1", input: "input" },
          { toolCallId: "test-call-id", messages: [] }
        );
      } catch (err) {
        error = err as TokenVaultInterrupt;
      }
    });

    it("should not throw any error", () => {
      expect(error).toBeUndefined();
    });

    it("should call the tool execute", () => {
      expect(mockTool.execute).toHaveBeenCalled();
    });

    it("should be able to retrieve the token from within the tool", () => {
      expect(accessToken).toBe("access_token");
    });
  });
});
