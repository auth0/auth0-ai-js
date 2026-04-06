import * as jose from "jose";
import { z } from "zod/v3";

export type AuthParams = {
  allowed?: boolean;
  accessToken?: string;
  claims?: jose.JWTPayload;
};

export type ToolWithAuthHandler<I, O, C> = (
  authParams: AuthParams,
  input: I,
  config?: C
) => Promise<O>;

export const Auth0ClientSchema = z.object({
  domain: z.string().default(() => process.env.AUTH0_DOMAIN!),
  clientId: z.string().default(() => process.env.AUTH0_CLIENT_ID!),
  clientSecret: z
    .union([z.string(), z.undefined()])
    .transform((v) => v ?? process.env.AUTH0_CLIENT_SECRET),
  telemetry: z.boolean().optional(),
  clientInfo: z
    .object({
      name: z.string(),
    })
    .passthrough()
    .optional(),
});

export const Auth0PublicClientSchema = z.object({
  domain: z.string().default(() => process.env.AUTH0_DOMAIN!),
  clientId: z.string().default(() => process.env.AUTH0_CLIENT_ID!),
});

export type Auth0ClientParams = z.infer<typeof Auth0ClientSchema>;
export type Auth0PublicClientParams = z.infer<typeof Auth0PublicClientSchema>;

export type OnAuthorizationRequest = "block" | "interrupt";
