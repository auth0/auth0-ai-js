export type AsyncAuthorizationRequest = {
  /**
   * The authorization request ID.
   * Use this ID to check the status of the authorization request.
   */
  id: string;

  /**
   * The time the authorization request was made.
   */
  requestedAt: number;

  /**
   * The time in seconds for the authorization request to expire.
   */
  expiresIn: number;

  /**
   * The interval in seconds to use when polling the status.
   */
  interval: number;
};
