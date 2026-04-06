import crypto from "crypto";
import stableHash from "stable-hash";

import {
  TokenResponse,
  TokenSet,
  tokenSetFromTokenResponse,
} from "../../credentials";
import {
  Auth0Interrupt,
  TokenVaultError,
  TokenVaultInterrupt,
} from "../../interrupts";
import { resolveParameter } from "../../parameters";
import { SubStore } from "../../stores";
import { omit, RequireFields } from "../../util";
import { ContextGetter, nsFromContext } from "../context";
import { Auth0ClientParams, Auth0ClientSchema } from "../types";
import { asyncLocalStorage, AsyncStorageValue } from "./asyncLocalStorage";
import {
  SUBJECT_TOKEN_TYPES,
  TokenVaultAuthorizerParams,
} from "./TokenVaultAuthorizerParams";

/**
 * Requests authorization to a third party service via Token Vault.
 */

export class TokenVaultAuthorizerBase<ToolExecuteArgs extends any[]> {
  private readonly auth0: Auth0ClientParams;
  private readonly params: RequireFields<
    TokenVaultAuthorizerParams<ToolExecuteArgs>,
    "credentialsContext"
  >;
  private readonly credentialsStore: SubStore<TokenSet>;

  constructor(
    auth0: Partial<Auth0ClientParams>,
    params: TokenVaultAuthorizerParams<ToolExecuteArgs>,
  ) {
    this.auth0 = Auth0ClientSchema.parse(auth0);
    this.params = {
      credentialsContext: "thread",
      ...params,
    };

    const instanceID = this.getInstanceID();

    this.credentialsStore = new SubStore<TokenSet>(params.store, {
      baseNamespace: [instanceID, "Credentials"],
      getTTL: (credentials) =>
        credentials.expiresIn ? credentials.expiresIn * 1000 : undefined,
    });

    // Validate that exactly one token source is provided
    const hasRefreshToken = typeof params.refreshToken !== "undefined";
    const hasAccessToken = typeof params.accessToken !== "undefined";
    const hasSubjectTokenType = typeof params.subjectTokenType !== "undefined";

    if (!hasRefreshToken && !hasAccessToken) {
      throw new Error(
        "Either refreshToken or accessToken must be provided to initialize the Authorizer.",
      );
    }

    if (hasRefreshToken && hasAccessToken) {
      throw new Error(
        "Only one of refreshToken or accessToken can be provided to initialize the Authorizer.",
      );
    }

    // Validate Custom API Client credentials when using access tokens for token exchange w/ Token Vault
    if (
      hasAccessToken &&
      hasSubjectTokenType &&
      params.subjectTokenType === SUBJECT_TOKEN_TYPES.SUBJECT_TYPE_ACCESS_TOKEN
    ) {
      if (!this.auth0.clientId || !this.auth0.clientSecret) {
        throw new Error(
          "clientId and clientSecret must currently be provided when using accessToken for token exchange with Token Vault.",
        );
      }
    }
  }

  private getInstanceID(): string {
    const props = {
      auth0: this.auth0,
      params: omit(this.params, [
        "store",
        "refreshToken",
        "accessToken",
        "loginHint",
      ]),
    };
    const sh = stableHash(props);
    return crypto.createHash("MD5").update(sh).digest("hex");
  }

  protected handleAuthorizationInterrupts(err: Auth0Interrupt) {
    throw err;
  }

  protected validateToken(tokenResponse?: TokenResponse) {
    const store = asyncLocalStorage.getStore();
    if (!store) {
      throw new Error(
        "The tool must be wrapped with the FederationConnectionAuthorizer.",
      );
    }

    const { scopes, connection, authorizationParams } = store;

    if (!tokenResponse) {
      throw new TokenVaultInterrupt(
        `Authorization required to access the Token Vault: ${this.params.connection}`,
        {
          connection,
          scopes,
          requiredScopes: scopes,
          authorizationParams,
        },
      );
    }

    const currentScopes = (tokenResponse.scope ?? "")
      .replace(/,/g, " ")
      .split(" ");
    const missingScopes = scopes.filter((s) => !currentScopes.includes(s));
    store.currentScopes = currentScopes;

    if (missingScopes.length > 0) {
      throw new TokenVaultInterrupt(
        `Authorization required to access the Token Vault: ${this.params.connection}. Authorized scopes: ${currentScopes.join(", ")}. Missing scopes: ${missingScopes.join(", ")}`,
        {
          connection,
          scopes,
          requiredScopes: [...currentScopes, ...missingScopes],
          authorizationParams,
        },
      );
    }
  }

  private async getAccessTokenImpl(
    ...toolContext: ToolExecuteArgs
  ): Promise<TokenResponse | undefined> {
    const store = asyncLocalStorage.getStore();
    if (!store) {
      throw new Error(
        "The tool must be wrapped with the FederationConnectionAuthorizer.",
      );
    }

    const { connection } = store;

    // Determine which token type to use and get the appropriate subject token
    let subjectToken: string | undefined;
    let subjectTokenType: string;

    if (typeof this.params.refreshToken === "function") {
      subjectToken = await this.getRefreshToken(...toolContext);
      subjectTokenType = "urn:ietf:params:oauth:token-type:refresh_token";
    } else if (typeof this.params.accessToken === "function") {
      subjectToken = (await this.getAccessTokenWithToolContext(
        ...toolContext,
      )) as string;
      subjectTokenType = "urn:ietf:params:oauth:token-type:access_token";
    } else if (typeof this.params.accessToken === "string") {
      subjectToken = this.params.accessToken;
      subjectTokenType = "urn:ietf:params:oauth:token-type:access_token";
    } else {
      // This should never happen due to constructor validation, but TypeScript needs this
      throw new Error("Either refreshToken or accessToken must be configured");
    }

    if (!subjectToken) {
      return;
    }

    // Get optional login hint if provided
    const loginHint =
      typeof this.params.loginHint === "function"
        ? await resolveParameter(this.params.loginHint, toolContext)
        : undefined;

    const exchangeParams = {
      grant_type:
        "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token",
      client_id: this.auth0.clientId,
      client_secret: this.auth0.clientSecret,
      subject_token_type: subjectTokenType,
      subject_token: subjectToken,
      login_hint: loginHint,
      connection: connection,
      requested_token_type:
        "http://auth0.com/oauth/token-type/federated-connection-access-token",
    };

    const res = await fetch(`https://${this.auth0.domain}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exchangeParams),
    });

    if (!res.ok) {
      //TODO: handle all type of response errors.
      return;
    }

    const tokenResponse: TokenResponse = await res.json();
    return tokenResponse;
  }

  protected async getAccessToken(
    ...toolContext: ToolExecuteArgs
  ): Promise<TokenSet> {
    let tokenResponse: TokenResponse | undefined;
    // Use token exchange for both refresh tokens and access tokens when subjectTokenType is provided
    if (
      typeof this.params.refreshToken === "function" ||
      (typeof this.params.accessToken !== "undefined" &&
        this.params.subjectTokenType ===
          SUBJECT_TOKEN_TYPES.SUBJECT_TYPE_ACCESS_TOKEN)
    ) {
      tokenResponse = await this.getAccessTokenImpl(...toolContext);
    } else {
      // fallback to existing behavior, where third party accessToken can be provided directly
      tokenResponse = (await resolveParameter(
        this.params.accessToken!,
        toolContext,
      )) as TokenResponse;
    }
    this.validateToken(tokenResponse);
    return tokenSetFromTokenResponse(tokenResponse!);
  }

  protected async getRefreshToken(...toolContext: ToolExecuteArgs) {
    return await resolveParameter(this.params.refreshToken, toolContext);
  }

  protected async getAccessTokenWithToolContext(
    ...toolContext: ToolExecuteArgs
  ) {
    return await resolveParameter(this.params.accessToken, toolContext);
  }

  /**
   *
   * Wraps the execute method of an AI tool to handle Token Vaults authorization.
   *
   * @param getContext - A function that returns the context of the tool execution.
   * @param execute - The tool execute method.
   * @returns The wrapped execute method.
   */
  protect(
    getContext: ContextGetter<ToolExecuteArgs>,
    execute: (...args: ToolExecuteArgs) => any,
  ): (...args: ToolExecuteArgs) => any {
    return async (...args: ToolExecuteArgs) => {
      const context = getContext(...args);
      const asyncStore: AsyncStorageValue = {
        context: context,
        scopes: this.params.scopes,
        connection: this.params.connection,
        authorizationParams: this.params.authorizationParams,
      };

      if (asyncLocalStorage.getStore()) {
        throw new Error(
          "Cannot nest tool calls that require Token Vault authorization.",
        );
      }

      return asyncLocalStorage.run(asyncStore, async () => {
        const credentialsNS = nsFromContext(
          this.params.credentialsContext,
          context,
        );
        try {
          let credentials: TokenSet = await this.credentialsStore.get(
            credentialsNS,
            "credential",
          );
          if (!credentials) {
            credentials = await this.getAccessToken(...args);
            await this.credentialsStore.put(
              credentialsNS,
              "credential",
              credentials,
            );
          }
          asyncStore.credentials = credentials;
          return await execute(...args);
        } catch (err) {
          if (err instanceof TokenVaultError) {
            this.credentialsStore.delete(credentialsNS, "credential");
            const interrupt = new TokenVaultInterrupt(err.message, {
              connection: asyncStore.connection,
              scopes: asyncStore.scopes,
              requiredScopes: asyncStore.scopes,
              authorizationParams: asyncStore.authorizationParams,
            });
            return this.handleAuthorizationInterrupts(interrupt);
          }
          if (err instanceof Auth0Interrupt) {
            this.credentialsStore.delete(credentialsNS, "credential");
            return this.handleAuthorizationInterrupts(err);
          }
          throw err;
        }
      });
    };
  }
}
