/** Authentication schemes a challenge can advertise. */
export type ChallengeScheme = "Bearer" | "DPoP";

/**
 * Error values a challenge can carry. `invalid_token`, `invalid_request` and
 * `insufficient_scope` come from RFC 6750 section 3.1; `invalid_dpop_proof` is
 * defined by RFC 9449 section 7.1 for the `DPoP` scheme, and `use_dpop_nonce`
 * by RFC 9449 section 9.
 */
export type ChallengeErrorCode =
  | "invalid_token"
  | "invalid_request"
  | "insufficient_scope"
  | "invalid_dpop_proof"
  | "use_dpop_nonce";

/** Input for {@link buildWwwAuthenticate}. */
export interface ChallengeOptions {
  /** Schemes to advertise, one challenge each. Must not be empty. */
  schemes: readonly ChallengeScheme[];
  /** Signing algorithms advertised on the `DPoP` challenge. Defaults to `['ES256']`. */
  dpopAlgs?: readonly string[];
  /**
   * Error to report. Leave it out when the request carried no credential at all:
   * RFC 6750 section 3.1 forbids an error value in that case.
   */
  error?: ChallengeErrorCode;
  /** Human readable, generic description. Never pass a raw library message. */
  errorDescription?: string;
  /** Scopes to list in the `scope` parameter (`insufficient_scope` responses). */
  scope?: readonly string[];
  /** Protection space, emitted as `realm`. */
  realm?: string;
  /** Absolute URL of the RFC 9728 protected resource metadata document. */
  resourceMetadata?: string;
  /**
   * Scheme the request used. It receives the error parameters; the other schemes
   * only advertise. Defaults to the first scheme.
   */
  errorScheme?: ChallengeScheme;
}

/**
 * Keeps only the characters RFC 6750 section 3 allows inside a quoted challenge
 * value (`%x20-21 / %x23-5B / %x5D-7E`). Quotes, backslashes, control characters
 * and anything outside printable ASCII are dropped, so a value can neither end
 * the quoted string nor inject another header field.
 */
export function sanitizeChallengeValue(value: string): string {
  return value.replace(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, "");
}

function sanitizeScopeList(scopes: readonly string[]): string {
  return scopes
    .map((scope) => sanitizeChallengeValue(scope).replace(/ /g, ""))
    .filter((scope) => scope !== "")
    .join(" ");
}

/**
 * Builds `WWW-Authenticate` header values, one per scheme. Every quoted value goes
 * through {@link sanitizeChallengeValue}; empty values are omitted.
 *
 * @throws {TypeError} When `schemes` is empty.
 */
export function buildWwwAuthenticate(options: ChallengeOptions): string[] {
  if (options.schemes.length === 0) {
    throw new TypeError("At least one challenge scheme is required.");
  }
  const errorScheme =
    options.errorScheme !== undefined &&
    options.schemes.includes(options.errorScheme)
      ? options.errorScheme
      : options.schemes[0];
  const realm =
    options.realm === undefined ? "" : sanitizeChallengeValue(options.realm);
  const description =
    options.errorDescription === undefined
      ? ""
      : sanitizeChallengeValue(options.errorDescription);
  const scope =
    options.scope === undefined ? "" : sanitizeScopeList(options.scope);
  const resourceMetadata =
    options.resourceMetadata === undefined
      ? ""
      : sanitizeChallengeValue(options.resourceMetadata);
  const algs = sanitizeChallengeValue(
    (options.dpopAlgs ?? ["ES256"]).join(" "),
  );

  return options.schemes.map((scheme) => {
    const params: string[] = [];
    if (realm !== "") params.push(`realm="${realm}"`);
    if (scheme === errorScheme && options.error !== undefined) {
      params.push(`error="${options.error}"`);
      if (description !== "") params.push(`error_description="${description}"`);
      if (scope !== "") params.push(`scope="${scope}"`);
    }
    if (scheme === "DPoP" && algs !== "") params.push(`algs="${algs}"`);
    if (resourceMetadata !== "")
      params.push(`resource_metadata="${resourceMetadata}"`);
    return params.length === 0 ? scheme : `${scheme} ${params.join(", ")}`;
  });
}
