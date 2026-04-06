import { afterEach, beforeEach, describe, expect, it, Mock, vi } from "vitest";

import { asyncLocalStorage, TokenVaultAuthorizerBase } from "../src/authorizers/token-vault";
import { TokenVaultError, TokenVaultInterrupt } from "../src/interrupts";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

describe("TokenVaultAuthorizerBase", () => {
  let authorizer: TokenVaultAuthorizerBase<[string]>;
  const getContext = vi.fn();
  const mockParams = {
    connection: "test-connection",
    scopes: ["read:calendar"],
    refreshToken: vi.fn().mockResolvedValue("test-refresh-token"),
    store: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    (getContext as Mock).mockReturnValue({
      threadID: "test-thread",
      toolCallID: "test-tool-call",
      toolName: "test-tool",
    });
    authorizer = new TokenVaultAuthorizerBase<[string]>(
      {
        domain: "test.auth0.com",
        clientId: "test-client",
        clientSecret: "test-secret",
      },
      mockParams
    );
  });

  describe("constructor", () => {
    it("should initialize with explicit params", () => {
      const auth = new TokenVaultAuthorizerBase<[string]>(
        {
          domain: "custom.auth0.com",
          clientId: "custom-client",
          clientSecret: "custom-secret",
        },
        mockParams
      );
      expect(auth).toBeInstanceOf(TokenVaultAuthorizerBase<[string]>);
    });
    it("should initialize with custom getAccessToken func", () => {
      const auth = new TokenVaultAuthorizerBase<[string]>(
        {
          domain: "custom.auth0.com",
          clientId: "custom-client",
          clientSecret: "custom-secret",
        },
        {
          store: mockParams.store,
          accessToken: () => {
            return {
              access_token: "test",
              id_token: "test",
              scope: "read:calendar",
              expires_in: 3600,
              token_type: "Bearer",
            };
          },
          connection: "google",
          scopes: ["read:calendar"],
        }
      );
      expect(auth).toBeInstanceOf(TokenVaultAuthorizerBase<[string]>);
    });
  });

  /**
   * If the refresh token can't be exchanged for an access token,
   * the authorizer should throw an error.
   *
   */
  describe("on exchange failure", () => {
    const execute = vi.fn();
    let err: Error;
    beforeEach(async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ error: "Unauthorized" }),
      });

      try {
        await authorizer.protect(getContext, execute)("test-context");
      } catch (er) {
        err = er as Error;
      }
    });

    it('should throw "Authorization required" error', async () => {
      expect(err.message).toMatch(
        /Authorization required to access the Token Vault/gi
      );
    });

    it("should not call the protected execute method", async () => {
      expect(execute).not.toHaveBeenCalled();
    });
  });

  /**
   * When the refresh token is exchanged for an access token with insufficient scopes
   * the authorizer should throw an error.
   */
  describe("on insufficient scopes", () => {
    const execute = vi.fn();
    let err: Error;
    beforeEach(async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          scope: "read:profile read:foobar",
          access_token: "test",
        }),
      });

      try {
        await authorizer.protect(getContext, execute)("test-context");
      } catch (er) {
        err = er as Error;
      }
    });

    it("should delete the current credentials", async () => {
      expect(mockParams.store.delete).toHaveBeenCalled();
      expect(mockParams.store.delete.mock.calls[0]).toMatchInlineSnapshot(`
        [
          [
            "7c7cbb63071e42d9c0fd403fcb140b3b",
            "Credentials",
            "Threads",
            "test-thread",
          ],
          "credential",
        ]
      `);
    });

    it('should throw "Authorization required" error', async () => {
      expect(err.message).toMatchInlineSnapshot(
        `"Authorization required to access the Token Vault: test-connection. Authorized scopes: read:profile, read:foobar. Missing scopes: read:calendar"`
      );
    });

    it("should not call the protected execute method", async () => {
      expect(execute).not.toHaveBeenCalled();
    });
  });

  /**
   * When the refresh token is exchanged for an access token with proper scopes
   * the authorizer should not throw an error and call the underlying execute method.
   */
  describe("on succesful exchange", () => {
    const execute = vi.fn();
    let err: Error;
    let accessTokenFromAsyncLocalStore: string | undefined;

    beforeEach(async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          scope: "read:profile read:calendar",
          access_token: "test",
        }),
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

    it("should not throw error", async () => {
      expect(err).toBeUndefined();
    });

    it("should not call the protected execute method", async () => {
      expect(execute).toHaveBeenCalled();
    });

    it("should store the access token in the async local storage", async () => {
      expect(accessTokenFromAsyncLocalStore).toBe("test");
    });

    it("should exchange the token properly", async () => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://test.auth0.com/oauth/token",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: expect.any(String),
        })
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toMatchInlineSnapshot(`
        {
          "client_id": "test-client",
          "client_secret": "test-secret",
          "connection": "test-connection",
          "grant_type": "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
          "requested_token_type": "http://auth0.com/oauth/token-type/federated-connection-access-token",
          "subject_token": "test-refresh-token",
          "subject_token_type": "urn:ietf:params:oauth:token-type:refresh_token",
        }
      `);
    });
  });

  /**
   * When the the tool call throws a TokenVaultError
   * the authorizer should delete the credentials
   * throw an interrupt error
   */
  describe("on TokenVaultError", () => {
    const execute = vi.fn().mockImplementation(() => {
      throw new TokenVaultError(
        "Authorization required to access the Token Vault: test-connection. Missing scopes: read:calendar"
      );
    });
    let err: Error;
    beforeEach(async () => {
      mockParams.store.get.mockReturnValue({
        accessToken: "foboar",
        tokenType: "Bearer",
      });

      try {
        await authorizer.protect(getContext, execute)("test-context");
      } catch (er) {
        err = er as Error;
      }
    });

    it("should delete the current credentials", async () => {
      expect(mockParams.store.delete).toHaveBeenCalled();
      expect(mockParams.store.delete.mock.calls[0]).toMatchInlineSnapshot(`
          [
            [
              "7c7cbb63071e42d9c0fd403fcb140b3b",
              "Credentials",
              "Threads",
              "test-thread",
            ],
            "credential",
          ]
        `);
    });

    it('should throw "Authorization required" interrupt', async () => {
      expect(err).toBeInstanceOf(TokenVaultInterrupt);
      expect(err.message).toMatchInlineSnapshot(
        `"Authorization required to access the Token Vault: test-connection. Missing scopes: read:calendar"`
      );
    });

    it("should not call the protected execute method", async () => {
      expect(execute).toHaveBeenCalled();
    });
  });
});
