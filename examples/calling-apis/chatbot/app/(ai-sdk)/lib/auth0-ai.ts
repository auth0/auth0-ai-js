import { auth0 } from "@/lib/auth0";
import { Auth0AI } from "@auth0/ai-vercel";

const auth0AI = new Auth0AI();

export const withGoogleCalendar = auth0AI.withTokenVault({
  refreshToken: async () => {
    const session = await auth0.getSession();
    const refreshToken = session?.tokenSet.refreshToken as string;
    return refreshToken;
  },
  connection: "google-oauth2",
  scopes: ["openid", "https://www.googleapis.com/auth/calendar.freebusy"],
});

export const withSlack = auth0AI.withTokenVault({
  refreshToken: async () => {
    const session = await auth0.getSession();
    const refreshToken = session?.tokenSet.refreshToken as string;
    return refreshToken;
  },
  connection: "sign-in-with-slack",
  scopes: ["channels:read", "groups:read"],
});

export const withGitHub = auth0AI.withTokenVault({
  refreshToken: async () => {
    const session = await auth0.getSession();
    const refreshToken = session?.tokenSet.refreshToken as string;
    return refreshToken;
  },
  connection: "github",
  scopes: ["repo"],
});

export const withGoogleDriveTools = auth0AI.withTokenVault({
  refreshToken: async () => {
    const session = await auth0.getSession();
    const refreshToken = session?.tokenSet.refreshToken as string;
    return refreshToken;
  },
  connection: "google-oauth2",
  scopes: ["openid", "https://www.googleapis.com/auth/drive"],
});
