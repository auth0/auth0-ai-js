# Authorization for tools with LlamaIndex

## Getting Started

### Prerequisites

- An OpenAI account and API key. You can create one [here](https://platform.openai.com).
  - [Use this page for instructions on how to find your OpenAI API key](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key)
- An [Auth0 FGA](https://fga.dev) account, or a running [OpenFGA](https://openfga.dev) instance.

#### `.env` file

Configure your `.env` file for your FGA provider:

**Auth0 FGA** - Set up a new Authorized Client from the `Settings` page in the [Auth0 FGA Dashboard](https://dashboard.fga.dev):

```sh
# OpenAI
OPENAI_API_KEY="<openai-api-key>"

# Auth0 FGA
FGA_STORE_ID="<fga-store-id>"
FGA_CLIENT_ID="<fga-client-id>"
FGA_CLIENT_SECRET="<fga-client-secret>"
# Required only for non-US regions
FGA_API_URL="https://api.xxx.fga.dev"
FGA_API_AUDIENCE="https://api.xxx.fga.dev/"
```

**OpenFGA** - Choose one auth mode: API Token or Client Credentials.

API Token:

```sh
# OpenAI
OPENAI_API_KEY="<openai-api-key>"

# OpenFGA
FGA_API_URL=http://localhost:8080
FGA_API_TOKEN="<fga-api-token>"
```

Client Credentials. Set `FGA_API_TOKEN_ISSUER` to a non-`auth.fga.dev` issuer so the example treats the provider as OpenFGA:

```sh
# OpenAI
OPENAI_API_KEY="<openai-api-key>"

# OpenFGA
FGA_API_URL=http://localhost:8080
FGA_API_TOKEN_ISSUER="https://your-openfga-issuer.example"
FGA_CLIENT_ID="<fga-client-id>"
FGA_CLIENT_SECRET="<fga-client-secret>"
```

For OpenFGA, you can either create the store manually and set `FGA_STORE_ID` in your `.env` file, or simply run `npm run fga:init` which will create the store automatically and save the `FGA_STORE_ID` to your `.env` file.

### How to run it

1. Install dependencies. If you want to run with local dependencies follow root instructions.
   ```sh
   npm install
   ```

2. Initialize the FGA store's model
   ```sh
   npm run fga:init
   ```

3. Running the example
   ```sh
   npm start
   ```

4. Try to buy `ATKO` or `ZEKO` stocks!


## License

Apache-2.0
