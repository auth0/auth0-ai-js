import { AuthenticationClient } from "auth0";
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from "vitest";

import { AsyncAuthorizerBase, asyncLocalStorage } from "../../src/authorizers/async-authorization";
import { ContextGetter } from "../../src/authorizers/context";

vi.mock("auth0");

describe("AsyncAuthorizerBase Block Mode", () => {
  let authorizer: AsyncAuthorizerBase<[string]>;
  const getContext: ContextGetter<[string]> = vi.fn();

  const mockParams = {
    userID: "user123",
    bindingMessage: "test-binding",
    scopes: ["read:users"],
    onAuthorizationRequest: "block" as const,
    onUnauthorized: vi.fn(),
    store: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };

  const mockAuth0 = {
    backchannel: {
      authorize: vi.fn(),
      backchannelGrant: vi.fn(),
    },
  };

  beforeEach(() => {
    (AuthenticationClient as any).mockImplementation(() => mockAuth0);
    (getContext as Mock).mockReturnValue({
      threadID: "test-thread",
      toolCallID: "test-tool-call",
      toolName: "test-tool",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    authorizer = new AsyncAuthorizerBase(
      {
        domain: "test.auth0.com",
        clientId: "test-client",
        clientSecret: "test-secret",
      },
      mockParams
    );
  });

  /**
   * The execution of the tool should be blocked until
   * the user approves the request.
   */
  describe("approving the auth request", () => {
    const startResponse = {
      auth_req_id: "test-id",
      expires_in: 3600,
      interval: 0.0001,
    };
    const execute = vi.fn();
    let err: Error;
    let accessTokenFromAsyncLocalStore: string | undefined;
    beforeEach(async () => {
      mockAuth0.backchannel.authorize.mockResolvedValue(startResponse);
      mockAuth0.backchannel.backchannelGrant
        .mockRejectedValueOnce({ error: "authorization_pending" })
        .mockRejectedValueOnce({ error: "authorization_pending" })
        .mockResolvedValueOnce({
          token_type: "bearer",
          access_token: "test-token",
        });
      execute.mockImplementation(() => {
        const store = asyncLocalStorage.getStore();
        accessTokenFromAsyncLocalStore = store?.credentials?.accessToken;
      });
      try {
        await authorizer.protect(getContext, execute)("test-context");
      } catch (er) {
        err = er as Error;
      }
    });

    it("should start the backchannel authorization", async () => {
      expect(mockAuth0.backchannel.authorize).toHaveBeenCalled();
    });

    it("should keep calling backchannelGrant until approved", async () => {
      expect(mockAuth0.backchannel.backchannelGrant).toHaveBeenCalledTimes(3);
    });

    it("should not interrupt", async () => {
      expect(err).toBeUndefined();
    });

    it("should make the token available to the execute context", async () => {
      expect(accessTokenFromAsyncLocalStore).toEqual("test-token");
    });
  });

  /**
   * When the user rejects the authorization request,
   * the authorizer will call the onUnauthorize function
   * to resolve the result of the tool
   */
  describe("when the request is rejected", () => {
    const startResponse = {
      auth_req_id: "test-id",
      expires_in: 3600,
      interval: 0.0001,
    };
    const execute = vi.fn();
    let err: Error;
    let toolResult: any;

    beforeEach(async () => {
      mockAuth0.backchannel.authorize.mockResolvedValue(startResponse);
      mockAuth0.backchannel.backchannelGrant
        .mockRejectedValueOnce({ error: "authorization_pending" })
        .mockRejectedValueOnce({
          error: "access_denied",
          error_description: "Access denied",
        });

      mockParams.onUnauthorized.mockResolvedValue(
        "User rejected the authorization request."
      );
      try {
        toolResult = await authorizer.protect(
          getContext,
          execute
        )("test-context");
      } catch (er) {
        err = er as Error;
      }
    });

    it("should start the backchannel authorization", async () => {
      expect(mockAuth0.backchannel.authorize).toHaveBeenCalled();
    });

    it("should keep calling backchannelGrant until approved", async () => {
      expect(mockAuth0.backchannel.backchannelGrant).toHaveBeenCalledTimes(2);
    });

    it("should not interrupt", async () => {
      expect(err).toBeUndefined();
    });

    it("should make the token available to the execute context", async () => {
      expect(toolResult).toMatchInlineSnapshot(
        `"User rejected the authorization request."`
      );
    });

    it('should call the onunauthorized callback with "access_denied"', async () => {
      expect(mockParams.onUnauthorized).toHaveBeenCalledOnce();
    });
  });

  /**
   * When the request is expired and the user has not
   * approved the request, the authorizer will call the
   * onUnauthorize function to resolve the result of the tool.
   */
  describe("when the request is expired", () => {
    const startResponse = {
      auth_req_id: "test-id",
      expires_in: 0.0001,
      interval: 0.001,
    };
    const execute = vi.fn();
    let err: Error;
    let toolResult: any;

    beforeEach(async () => {
      mockAuth0.backchannel.authorize.mockResolvedValue(startResponse);
      mockAuth0.backchannel.backchannelGrant.mockRejectedValue({
        error: "authorization_pending",
      });

      mockParams.onUnauthorized.mockResolvedValue(
        "User rejected the authorization request."
      );
      try {
        toolResult = await authorizer.protect(
          getContext,
          execute
        )("test-context");
      } catch (er) {
        err = er as Error;
      }
    });

    it("should start the backchannel authorization", async () => {
      expect(mockAuth0.backchannel.authorize).toHaveBeenCalled();
    });

    it("should not interrupt", async () => {
      expect(err).toBeUndefined();
    });

    it("should make the token available to the execute context", async () => {
      expect(toolResult).toMatchInlineSnapshot(
        `"User rejected the authorization request."`
      );
    });

    it('should call the onunauthorized callback with "access_denied"', async () => {
      expect(mockParams.onUnauthorized).toHaveBeenCalledOnce();
    });
  });
});
