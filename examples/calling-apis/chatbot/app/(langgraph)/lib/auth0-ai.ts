import { SUBJECT_TOKEN_TYPES } from "@auth0/ai";
import { Auth0AI } from "@auth0/ai-langchain";

const auth0AI = new Auth0AI({
  auth0: {
    domain: process.env.AUTH0_DOMAIN!,
    clientId: process.env.AUTH0_CUSTOM_API_CLIENT_ID!, // Custom API Client ID for token exchange
    clientSecret: process.env.AUTH0_CUSTOM_API_CLIENT_SECRET!, // Custom API Client secret
  },
});

const withAccessTokenForConnection = (connection: string, scopes: string[]) =>
  auth0AI.withTokenVault({
    connection,
    scopes,
    accessToken: async (_, config) => {
      return config.configurable?.langgraph_auth_user?.getRawAccessToken();
    },
    subjectTokenType: SUBJECT_TOKEN_TYPES.SUBJECT_TYPE_ACCESS_TOKEN,
  });

export const withGoogleCalendar = withAccessTokenForConnection(
  "google-oauth2",
  ["https://www.googleapis.com/auth/calendar.freebusy"]
);

export const withGitHub = withAccessTokenForConnection("github", ["repo"]);

export const withSlack = withAccessTokenForConnection("sign-in-with-slack", [
  "channels:read",
  "groups:read",
]);

export const withGoogleCalendarCommunity = withAccessTokenForConnection(
  "google-oauth2",
  [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
  ]
);

export const withGmailCommunity = withAccessTokenForConnection(
  "google-oauth2",
  ["https://mail.google.com/"]
);
