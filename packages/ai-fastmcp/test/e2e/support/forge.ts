/**
 * Hostile bearer values built from one real tenant token. The real header supplies a `kid` the
 * tenant really publishes, so the verifier gets as far as the signature check.
 */
import { SignJWT, generateKeyPair } from "jose";
import { decodeClaims, decodeHeader } from "./tokens.js";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The real token with one character of its payload changed. The signature no longer matches. */
export function withTamperedPayload(token: string): string {
  const [header, payload, signature] = token.split(".");
  const index = Math.floor(payload!.length / 2);
  const replacement = payload![index] === "A" ? "B" : "A";
  return [header, payload!.slice(0, index) + replacement + payload!.slice(index + 1), signature].join(".");
}

/** The real header and payload with `alg: none` and no signature. */
export function withAlgNone(token: string): string {
  const [, payload] = token.split(".");
  return `${b64({ alg: "none", typ: "JWT" })}.${payload}.`;
}

/** Only the header segment of the real token. */
export function headerOnly(token: string): string {
  return token.split(".")[0]!;
}

/** The real header and payload with a signature that is not the tenant's. */
export function withForeignSignature(token: string): string {
  const [header, payload] = token.split(".");
  return `${header}.${payload}.${Buffer.from("not the tenant signature, only some bytes").toString("base64url")}`;
}

/**
 * A token signed with a key the tenant does not publish, claiming the tenant as issuer and the
 * server as audience, with the `kid` of the real token. Pass `issuer` to claim another issuer.
 */
export async function signedByAttacker(real: string, overrides: { issuer?: string; audience?: string } = {}): Promise<string> {
  const claims = decodeClaims(real);
  const header = decodeHeader(real);
  const { privateKey } = await generateKeyPair("RS256");
  return new SignJWT({ scope: typeof claims["scope"] === "string" ? claims["scope"] : "" })
    .setProtectedHeader({ alg: "RS256", ...(typeof header["kid"] === "string" && { kid: header["kid"] }) })
    .setIssuer(overrides.issuer ?? String(claims["iss"]))
    .setAudience(overrides.audience ?? String(claims["aud"]))
    .setSubject(String(claims["sub"]))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}
