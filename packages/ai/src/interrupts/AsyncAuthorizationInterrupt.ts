import { AsyncAuthorizationRequest } from "../authorizers/async-authorization/AsyncAuthorizationRequest";
import { Auth0Interrupt, Auth0InterruptData } from "./Auth0Interrupt";

export interface WithRequestData {
  request: AsyncAuthorizationRequest;
}

/**
 * Base class for Async Authorization interrupts.
 */
export class AsyncAuthorizationInterrupt extends Auth0Interrupt {
  constructor(message: string, code: string) {
    super(message, code);
  }

  static isInterrupt<T extends abstract new (...args: any) => any>(
    this: T & { code?: string },
    interrupt: any
  ): interrupt is Auth0InterruptData<InstanceType<T>> {
    return (
      interrupt &&
      Auth0Interrupt.isInterrupt(interrupt) &&
      typeof interrupt.code === "string" &&
      (this.code === interrupt.code ||
        (!this.code && interrupt.code.startsWith("ASYNC_AUTHORIZATION_")))
    );
  }

  static hasRequestData(interrupt: any): interrupt is WithRequestData {
    return AsyncAuthorizationInterrupt.isInterrupt(interrupt) && "request" in interrupt;
  }
}

/**
 * An interrupt that is thrown when the user denies the authorization request.
 */
export class AccessDeniedInterrupt
  extends AsyncAuthorizationInterrupt
  implements WithRequestData
{
  public static code: string = "ASYNC_AUTHORIZATION_ACCESS_DENIED" as const;
  constructor(
    message: string,
    public readonly request: AsyncAuthorizationRequest
  ) {
    super(message, AccessDeniedInterrupt.code);
  }
}

/**
 * An interrupt that is thrown when the user does not have push notifications enabled.
 */
export class UserDoesNotHavePushNotificationsInterrupt extends AsyncAuthorizationInterrupt {
  public static code: string =
    "ASYNC_AUTHORIZATION_USER_DOES_NOT_HAVE_PUSH_NOTIFICATIONS" as const;
  constructor(message: string) {
    super(message, UserDoesNotHavePushNotificationsInterrupt.code);
  }
}

/**
 * An interrupt that is thrown when the authorization request has expired.
 */
export class AuthorizationRequestExpiredInterrupt
  extends AsyncAuthorizationInterrupt
  implements WithRequestData
{
  public static code: string = "ASYNC_AUTHORIZATION_AUTHORIZATION_REQUEST_EXPIRED" as const;
  constructor(
    message: string,
    public readonly request: AsyncAuthorizationRequest
  ) {
    super(message, AuthorizationRequestExpiredInterrupt.code);
  }
}

/**
 * An interrupt that is thrown when the authorization is still pending
 * and the Authorizer is in `mode: interrupt`.
 */
export class AuthorizationPendingInterrupt
  extends AsyncAuthorizationInterrupt
  implements WithRequestData
{
  public static code: string = "ASYNC_AUTHORIZATION_AUTHORIZATION_PENDING" as const;
  constructor(
    message: string,
    public readonly request: AsyncAuthorizationRequest
  ) {
    super(message, AuthorizationPendingInterrupt.code);
  }

  /**
   * Returns the interval in seconds to wait until the next polling attempt.
   */
  public nextRetryInterval(): number {
    return this.request.interval;
  }
}

/**
 * An interrupt that is thrown when the authorization polling fails.
 */
export class AuthorizationPollingInterrupt
  extends AsyncAuthorizationInterrupt
  implements WithRequestData
{
  public static code: string = "ASYNC_AUTHORIZATION_AUTHORIZATION_POLLING_ERROR" as const;
  constructor(
    message: string,
    public readonly request: AsyncAuthorizationRequest,
    public readonly retryAfter: number
  ) {
    super(message, AuthorizationPollingInterrupt.code);
  }

  /**
   * Returns the interval in seconds to wait until the next polling attempt.
   */
  public nextRetryInterval(): number {
    return this.retryAfter || this.request.interval;
  }
}

/**
 * An interrupt that is thrown when the authorization polling fails.
 */
export class InvalidGrantInterrupt
  extends AsyncAuthorizationInterrupt
  implements WithRequestData
{
  public static code: string = "ASYNC_AUTHORIZATION_INVALID_GRANT" as const;
  constructor(
    message: string,
    public readonly request: AsyncAuthorizationRequest
  ) {
    super(message, InvalidGrantInterrupt.code);
  }
}
