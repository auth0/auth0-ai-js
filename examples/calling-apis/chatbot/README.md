# Chat Application with Auth0 AI and AI SDK

This is a [Next.js](https://nextjs.org) application that implements [Auth0 AI](https://auth0.ai) along with the [AI SDK](https://sdk.vercel.ai/) and to create a chat bot with [OpenAI](https://platform.openai.com) as engine. The application demonstrates how to integrate the AI SDK with Auth0 AI to implement: Authentication & Authorization of apps & APIs with Auth0.

## Getting Started

### Prerequisites

- An OpenAI account and API key. You can create one [here](https://platform.openai.com).
  - [Use this page for instructions on how to find your OpenAI API key](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key)
- An **[Auth0](https://auth0.com)** account and the following settings and resources configured:
  - An application to initiate the authorization flow:
    - **Application Type**: `Regular Web Application`
    - **Allowed Callback URLs**: `http://localhost:3000/auth/callback`
    - **Allowed Logout URLs**: `http://localhost:3000`
    - **Grant Type**: `Token Vault` (or `urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token`). You should also ensure that the `Refresh Token` grant type is enabled for flows which do not use an external API.
    - **Allow Refresh Token Rotation**: currently you should disable this setting if you are using Token Vault for token exchanges with a refresh token.
  - An API for representing the external Langgraph API Server
    - In your Auth0 Dashboard, go to Applications > APIs
    - Create a new API with an identifier (audience).
    - Ensure that "Allow Offline Access" is enabled for your API if you are using a flow which still makes use of refresh tokens.
  - A Custom API Client for performing token exchanges with Token Vault on behalf of a user. This will be used by the Langgraph API server (@langchain/langgraph-cli or Langgraph Platform) when executing tools that require third-party access.
    - On the settings page for the previously created API, click the "Add Application" button in the header and create the Custom API Client.
    - Ensure that the `Token Vault` grant type is enabled under the Advanced Settings.
    - Note down the "Client ID" and "Client Secret" of this newly created Custom API Client.
  - Either **Google**, **Slack** or **GitHub** social connections enabled for the application.

### Pre-requisite: Grant access to My Account API from your web application

When a call to Token Vault fails due to the user not having a connected account (or lacking some permissions), this demo triggers a Connect Account flow for this user. This flow leverages Auth0's [My Account API](https://auth0.com/docs/manage-users/my-account-api), and as such, your application will need to have access to it in order to enable this flow.

n order to grant access, use the [Application Access to APIs](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants) feature, by creating a client grant for user flows.

- In your Auth0 Dashboard, go to APIs, and open the Settings for "Auth0 My Account API".
- On the Applications tab, authorize your web application, ensuring that the `create:me:connected_accounts` permission at least is selected.

### Pre-requisite: Define a Multi-Resource Refresh Token policy for your web application

After your web application has been granted access to the My Account API, you will also need to leverage the [Multi-Resource Refresh Token](https://auth0.com/docs/secure/tokens/refresh-tokens/multi-resource-refresh-token) feature, where the refresh token delivered to your application will also allow it to obtain an access token to call My Account API.

This will require defining a new [refresh token policy](https://auth0.com/docs/secure/tokens/refresh-tokens/multi-resource-refresh-token/configure-and-implement-multi-resource-refresh-token) for your web application where the `audience` is `https://<your auth0 domain>/me/` and the `scope` should include at least the `"create:me:connected_accounts"` scope.

The configuration page explains how to achieve this using various tools, but here is an example showing how to do it with `curl`:

```shell
curl --request PATCH \
  --url 'https://{yourDomain}/api/v2/clients/{yourClientId}' \
  --header 'authorization: Bearer {yourMgmtApiAccessToken}' \
  --header 'content-type: application/json' \
  --data '{
  "refresh_token": {
    "expiration_type": "expiring",
    "rotation_type": "rotating",
    "token_lifetime": 31557600,
    "idle_token_lifetime": 2592000,
    "leeway": 0,
    "infinite_token_lifetime": false,
    "infinite_idle_token_lifetime": false,
    "policies": [
      {
        "audience": "https://{yourDomain}/me/",
        "scope": [
          "create:me:connected_accounts"
        ]
      }
    ]
  }
}'
```

<details>

<summary>How to get a Management API Token from the Dashboard</summary>

To create a token exchange profile, you need a Management API access token with the appropriate scopes.

The quickest way to get a token for testing is from the Auth0 Dashboard:
* Navigate to Applications > APIs in your Auth0 Dashboard
* Select Auth0 Management API
* Click on the API Explorer tab
* Copy the displayed token

</details>

### Setup the workspace `.env` file

Copy the `.env.example` file to `.env` and fill in the values for the following variables, using the settings obtained from the prerequisites:

```bash
# Auth0
AUTH0_DOMAIN="<auth0-domain>"
AUTH0_CLIENT_ID="<auth0-client-id>"
AUTH0_CLIENT_SECRET="<auth0-client-secret>"
AUTH0_SECRET="<use [openssl rand -hex 32] to generate a 32 bytes value>"
APP_BASE_URL=http://localhost:3000
# the offline_access scope is needed if your flow is using a refresh token
AUTH0_SCOPE='openid profile email offline_access'
# Langgraph API audience (only needed for Langgraph example)
AUTH0_AUDIENCE="<auth0-audience>"
NEXT_PUBLIC_URL="http://localhost:3000"

# OpenAI
OPENAI_API_KEY=xx-xxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxx

# LANGGRAPH
LANGGRAPH_API_URL=http://localhost:54367
# Auth0 Custom API Client Configuration (for token exchange with Token Vault)
# These credentials belong to a special "resource_server" client that can perform token exchanges
# on behalf of the user within your Langgraph API. Only needed for Langgraph example.
AUTH0_CUSTOM_API_CLIENT_ID="<your-custom-api-client-id>"
AUTH0_CUSTOM_API_CLIENT_SECRET="<your-custom-api-client-secret>"
```

> [!NOTE]
> Auth0 config is necessary to run the authentication & authorization flows. Make sure to utilize a [Web Application type of client](https://auth0.com/docs/get-started/auth0-overview/create-applications/regular-web-apps).

### Install & run

Install the dependencies running the following command:

```bash
npm install
```

Then, run the Next.js development server like:

```bash
npm run dev
```

This will start the development server at [http://localhost:3000](http://localhost:3000). You can open the URL with your browser to try the application.

> [!NOTE]
> For the [Langgraph example](/examples/calling-apis/chatbot/app/(langgraph)/) to work, it's necessary to run a local Langgraph server with the following command:
> ```bash
> npm run langgraph:dev
> ```
> Alternatively, you can always use a remote one and update the `LANGGRAPH_API_URL` from the `.env` file here.

## Learn More

To learn more about the Auth0 AI and the other AI SDKs utilized on these examples:

- [Auth0 AI](https://auth0.ai)
- [AI SDK](https://sdk.vercel.ai/)
- [Genkit](https://firebase.google.com/docs/genkit)
- [LlamaIndex](https://ts.llamaindex.ai/)
- [LangGraph](https://langchain-ai.github.io/langgraph/)
- [Next.js](https://nextjs.org)
- [Next.js-Auth0](https://github.com/auth0/nextjs-auth0)

## License

Apache-2.0
