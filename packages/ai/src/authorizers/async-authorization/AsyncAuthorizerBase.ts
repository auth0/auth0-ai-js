import { AuthenticationClient } from "auth0";
import crypto from "crypto";
import stableHash from "stable-hash";

import { TokenSet, tokenSetFromTokenResponse } from "../../credentials";
import {
  AccessDeniedInterrupt,
  AuthorizationPendingInterrupt,
  AuthorizationPollingInterrupt,
  AuthorizationRequestExpiredInterrupt,
  InvalidGrantInterrupt,
  UserDoesNotHavePushNotificationsInterrupt,
} from "../../interrupts";
import { resolveParameter } from "../../parameters";
import { SubStore } from "../../stores";
import { RequireFields } from "../../util";
import { ContextGetter, nsFromContext } from "../context";
import { Auth0ClientParams, Auth0ClientSchema } from "../types";
import { AsyncAuthorizationRequest } from "./AsyncAuthorizationRequest";
import { AsyncAuthorizerParams } from "./AsyncAuthorizerParams";
import { asyncLocalStorage, AsyncStorageValue } from "./asyncLocalStorage";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function ensureOpenIdScope(scopes: string[]): string[] {
  return scopes.includes("openid") ? scopes : ["openid", ...scopes];
}
/**
 * Requests authorization by prompting the user via an out-of-band channel from
 * the backend.
 */
export class AsyncAuthorizerBase<ToolExecuteArgs extends any[]> {
  private readonly auth0: AuthenticationClient;
  private readonly authResponseStore: SubStore | undefined;
  private readonly credentialsStore: SubStore<TokenSet> | undefined;

  private readonly params: RequireFields<
    AsyncAuthorizerParams<ToolExecuteArgs>,
    "credentialsContext"
  >;

  constructor(
    auth0: Partial<Auth0ClientParams>,
    params: AsyncAuthorizerParams<ToolExecuteArgs>
  ) {
    this.auth0 = new AuthenticationClient(Auth0ClientSchema.parse(auth0));
    this.params = {
      credentialsContext: "tool-call",
      ...params,
    };

    this.authResponseStore = new SubStore<AsyncAuthorizationRequest>(
      params.store,
      {
        getTTL: (authResponse) =>
          authResponse.expiresIn ? authResponse.expiresIn * 1000 : undefined,
      }
    );

    this.credentialsStore = new SubStore<TokenSet>(params.store, {
      getTTL: (credentials) =>
        credentials.expiresIn ? credentials.expiresIn * 1000 : undefined,
    });
  }

  private getInstanceID(authorizeParams: any): string {
    const props = {
      auth0: this.auth0,
      params: authorizeParams,
    };
    const sh = stableHash(props);
    return crypto.createHash("MD5").update(sh).digest("hex");
  }

  private async start(authorizeParams: any): Promise<AsyncAuthorizationRequest> {
    const requestedAt = Date.now() / 1000;

    try {
      const response = await this.auth0.backchannel.authorize(authorizeParams);

      return {
        id: response.auth_req_id,
        requestedAt: requestedAt,
        expiresIn: response.expires_in,
        interval: response.interval,
      };
    } catch (err: any) {
      if (err.error == "invalid_request") {
        throw new UserDoesNotHavePushNotificationsInterrupt(
          err.error_description
        );
      }
      throw err;
    }
  }

  private async getAuthorizeParams(toolContext: ToolExecuteArgs) {
    const authParams: Record<string, any> = {
      scope: ensureOpenIdScope(this.params.scopes).join(" "),
      audience: this.params.audience || "",
      requested_expiry: (this.params.requestedExpiry ?? 300).toString(),
      binding_message:
        (await resolveParameter(this.params.bindingMessage, toolContext)) ?? "",
      userId: (await resolveParameter(this.params.userID, toolContext)) ?? "",
    };

    const authorizationDetails = await resolveParameter(
      this.params.authorizationDetails,
      toolContext
    );

    // If authorizationDetails is an array, we need to convert it to a string
    // because the auth0 library expects a valid JSON string.
    if (authorizationDetails !== undefined) {
      authParams.authorization_details = JSON.stringify(authorizationDetails);
    }

    // Remove undefined values from the authParams object
    return Object.fromEntries(
      Object.entries(authParams).filter(([, value]) => value !== undefined)
    );
  }

  private async getCredentialsInternal(
    authRequest: AsyncAuthorizationRequest
  ): Promise<TokenSet | undefined> {
    try {
      const elapsedSeconds = Date.now() / 1000 - authRequest.requestedAt;

      if (elapsedSeconds >= authRequest.expiresIn) {
        throw new AuthorizationRequestExpiredInterrupt(
          "The authorization request has expired.",
          authRequest
        );
      }

      const response = await this.auth0.backchannel.backchannelGrant({
        auth_req_id: authRequest.id,
      });

      const credentials = tokenSetFromTokenResponse(response);

      return credentials;
    } catch (e: any) {
      if (e.error === "authorization_pending") {
        throw new AuthorizationPendingInterrupt(
          e.error_description,
          authRequest
        );
      }

      if (e.error === "slow_down") {
        throw new AuthorizationPollingInterrupt(
          e.error_description,
          authRequest,
          Number(e.headers.get('retry-after'))
        );
      }

      if (e.error == "invalid_grant") {
        throw new InvalidGrantInterrupt(e.error_description, authRequest);
      }

      if (e.error == "invalid_request") {
        throw new UserDoesNotHavePushNotificationsInterrupt(
          e.error_description
        );
      }

      if (e.error == "access_denied") {
        throw new AccessDeniedInterrupt(e.error_description, authRequest);
      }

      throw e;
    }
  }

  protected async getCredentials(authRequest: AsyncAuthorizationRequest) {
    return this.getCredentialsInternal(authRequest);
  }

  protected async getCredentialsPolling(
    authRequest: AsyncAuthorizationRequest
  ): Promise<TokenSet | undefined> {
    let credentials: TokenSet | undefined = undefined;

    do {
      try {
        credentials = await this.getCredentialsInternal(authRequest);
      } catch (err) {
        if (
          err instanceof AuthorizationPendingInterrupt ||
          err instanceof AuthorizationPollingInterrupt
        ) {
          await sleep(err.nextRetryInterval() * 1000);
        } else {
          throw err;
        }
      }
    } while (!credentials);

    return credentials;
  }

  protected deleteAuthRequest() {
    const store = asyncLocalStorage.getStore();
    if (!store) {
      throw new Error("This method should be called from within a tool.");
    }
    const { authResponseNS } = store;
    return this.authResponseStore?.delete(authResponseNS, "authResponse");
  }

  /**
   *
   * Wraps the execute method of a AI tool to handle CIBA authorization.
   *
   * @param getContext - A function that returns the context of the tool execution.
   * @param execute - The tool execute method.
   * @returns The wrapped execute method.
   */
  protect(
    getContext: ContextGetter<ToolExecuteArgs>,
    execute: (...args: ToolExecuteArgs) => any
  ): (...args: ToolExecuteArgs) => any {
    return async (...args: ToolExecuteArgs) => {
      let authResponse: AsyncAuthorizationRequest | undefined;
      if (asyncLocalStorage.getStore()) {
        throw new Error(
          "Cannot nest tool calls that require CIBA authorization."
        );
      }

      const context = getContext(...args);
      const authorizeParams = await this.getAuthorizeParams(args);
      const instanceID = this.getInstanceID(authorizeParams);
      const authResponseNS = [
        instanceID,
        "AuthResponses",
        ...nsFromContext("tool-call", context),
      ];
      const credentialsNS = [
        instanceID,
        "Credentials",
        ...nsFromContext(this.params.credentialsContext, context),
      ];

      const storeValue: AsyncStorageValue<any> = {
        args,
        context,
        authResponseNS,
      };

      return asyncLocalStorage.run(storeValue, async () => {
        let credentials: TokenSet | undefined;

        const interruptMode =
          typeof this.params.onAuthorizationRequest === "undefined" ||
          this.params.onAuthorizationRequest === "interrupt";

        try {
          credentials = await this.credentialsStore?.get(
            credentialsNS,
            "credential"
          );
          if (!credentials) {
            if (interruptMode) {
              authResponse = await this.authResponseStore?.get(
                authResponseNS,
                "authResponse"
              );
              if (!authResponse) {
                //Initial request
                authResponse = await this.start(authorizeParams);
                await this.authResponseStore?.put(
                  authResponseNS,
                  "authResponse",
                  authResponse
                );
              }
              credentials = await this.getCredentials(authResponse);
            } else {
              authResponse = await this.start(authorizeParams);
              const credentialsPromise =
                this.getCredentialsPolling(authResponse);
              if (typeof this.params.onAuthorizationRequest === "function") {
                await this.params.onAuthorizationRequest(
                  authResponse,
                  credentialsPromise
                );
              }
              credentials = await credentialsPromise;
            }
            await this.deleteAuthRequest();
            if (typeof credentials !== "undefined") {
              this.credentialsStore?.put(
                credentialsNS,
                "credential",
                credentials
              );
            }
          }
        } catch (err) {
          const shouldInterrupt =
            err instanceof AuthorizationPendingInterrupt ||
            err instanceof AuthorizationPollingInterrupt;
          if (shouldInterrupt) {
            return this.handleAuthorizationInterrupts(err);
          } else {
            await this.deleteAuthRequest();
            if (typeof this.params.onUnauthorized === "function") {
              return this.params.onUnauthorized(err as Error, ...args);
            } else {
              return err;
            }
          }
        }
        storeValue.credentials = credentials;
        return execute(...args);
      });
    };
  }

  protected async handleAuthorizationInterrupts(
    err: AuthorizationPendingInterrupt | AuthorizationPollingInterrupt
  ) {
    if (this.params.onAuthorizationInterrupt) {
      const store = asyncLocalStorage.getStore();
      if (!store) {
        throw new Error("This method should be called from within a tool.");
      }
      const { context } = store;
      await this.params.onAuthorizationInterrupt(err, context);
    }
    throw err;
  }
}
