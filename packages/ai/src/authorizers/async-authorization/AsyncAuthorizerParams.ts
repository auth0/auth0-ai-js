import { AuthorizationDetails, TokenSet } from "../../credentials";
import {
  AsyncAuthorizationInterrupt,
  AuthorizationPendingInterrupt,
  AuthorizationPollingInterrupt,
} from "../../interrupts";
import { AuthorizerToolParameter } from "../../parameters";
import { Store } from "../../stores";
import { AuthContext, ToolCallContext } from "../context";
import { OnAuthorizationRequest } from "../types";
import { AsyncAuthorizationRequest } from "./AsyncAuthorizationRequest";

export type AsyncAuthorizerParams<ToolExecuteArgs extends any[]> = {
  /**
   * The scope to request authorization for.
   */
  scopes: string[];

  /**
   * The user ID to request authorization for.
   */
  userID: AuthorizerToolParameter<ToolExecuteArgs>;

  /**
   * The binding message to send to the user.
   */
  bindingMessage: AuthorizerToolParameter<ToolExecuteArgs>;

  /**
   * The authorization parameters for RAR request.
   */
  authorizationDetails?: AuthorizerToolParameter<
    ToolExecuteArgs,
    AuthorizationDetails[]
  >;

  /**
   * The audience to request authorization for.
   */
  audience?: string;

  /**
   * The time in seconds for the authorization request to expire.
   *
   * Defaults to 300 (5 minutes).
   */
  requestedExpiry?: number;

  /**
   * The behavior when the authorization request is made.
   *
   * - `block`: The tool execution is blocked until the user completes the authorization.
   * - `interrupt`: The tool execution is interrupted until the user completes the authorization.
   * - a callback: Same as "block" but give access to the auth request and executing logic.
   *
   * Defaults to `interrupt`.
   * Note: The block mode is only useful for development purposes and should not be used in production.
   */
  onAuthorizationRequest?:
    | OnAuthorizationRequest
    | ((
        authReq: AsyncAuthorizationRequest,
        poll: Promise<TokenSet | undefined>
      ) => Promise<void>);

  /**
   * AuthContext defines the scope of credential sharing:
   * - "tool-call": Credentials are valid only for a single invocation of the tool.
   * - "tool": Credentials are shared across multiple calls to the same tool within the same thread.
   * - "thread": Credentials are shared across all tools using the same authorizer within the current thread.
   * - "agent": Credentials are shared globally across all threads and tools in the agent.
   *
   * @default "tool-call"
   */
  credentialsContext?: AuthContext;

  /**
   *
   * Optional callback to generate a tool result when the invocation is not authorized.
   *
   * By default it will return the instance of the Error.
   *
   * @param args - The tool execution arguments.
   * @returns The response to return when the invocation is not authorized.
   */
  onUnauthorized?: (
    err: Error | AsyncAuthorizationInterrupt,
    ...args: ToolExecuteArgs
  ) => any;

  /**
   * Callback called before the authorization interrupt is thrown.
   * This callback is useful to setup CIBA pollers.
   *
   * @param interrupt - The interrupt that is about to be thrown.
   * @param args - The tool execution arguments.
   */
  onAuthorizationInterrupt?: (
    interrupt: AuthorizationPendingInterrupt | AuthorizationPollingInterrupt,
    context: ToolCallContext,
  ) => void | Promise<void>;

  /**
   * An store used to temporarly store the authorization response data
   * while the user is completing the authorization in another device.
   */
  store: Store;
};
