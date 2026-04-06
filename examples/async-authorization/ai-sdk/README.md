# Step Up Auth for Tools with AI SDK

## Getting Started

### Prerequisites

- An OpenAI account and API key. You can create one [here](https://platform.openai.com).
  - [Use this page for instructions on how to find your OpenAI API key](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key)
- An **[Auth0](https://auth0.com)** account and the following settings and resources configured:
  - An application for Device flow with the following settings:
    - **Application Type**: `Native`
    - **Grant Type**: `Device Code` (or `urn:ietf:params:oauth:grant-type:device_code`)
  - An additional application for Async Authorization with the following settings:
    - **Application Type**: `Web Application`
    - **Grant Type**: `CIBA` (or `urn:openid:params:grant-type:ciba`)
  - An API with the following settings:
    - **Name**: `Sample API`
    - **Identifier**: `sample-api`
    - **Permissions**: `stock:trade`
  - **Push Notifications** using [Auth0 Guardian](https://auth0.com/docs/secure/multi-factor-authentication/auth0-guardian) must be `enabled`
  - A test user enrolled in Guardian MFA.

### Setup the workspace `.env` file

Copy the `.env.example` file to `.env` and fill in the values for the following variables, using the settings obtained from the prerequisites:

```sh
# Auth0
AUTH0_DOMAIN="<auth0-domain>"
# Client for Async Authorization
AUTH0_CLIENT_ID="<auth0-client-id>"
AUTH0_CLIENT_SECRET="<auth0-client-secret>"
# Client for Device Flow / Native
AUTH0_PUBLIC_CLIENT_ID="<auth0-public-client-id>"
AUTH0_PUBLIC_CLIENT_SECRET="<auth0-public-client-secret>"

# API
API_URL=http://localhost:8081/
AUDIENCE=sample-api

# OpenAI
OPENAI_API_KEY="openai-api-key"
```

### How to run it

1. Install dependencies.
    ```sh
    npm install
    ```
    > If you want to run with local dependencies follow root instructions.

2. Running the API
    ```sh
    npm run start:api
    ```

3. Running the example
    ```sh
    npm start
    ```

4. Try to buy some `zeko` stocks!

## License

Apache-2.0
