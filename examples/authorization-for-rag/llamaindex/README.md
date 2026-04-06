# LlamaIndex Retrievers + Auth0 FGA/OpenFGA

This example demonstrates how to combine [LlamaIndex](https://ts.llamaindex.ai/) with robust authorization controls for RAG workflows. Using [Auth0 FGA](https://docs.fga.dev)/[OpenFGA](https://openfga.dev), it ensures that users can only access documents they are authorized to view. The example retrieves relevant documents, enforces access permissions, and generates responses based only on authorized data, maintaining strict data security and preventing unauthorized access.

## Getting Started

### Prerequisites

- An OpenAI account and API key. You can create one [here](https://platform.openai.com).
  - [Use this page for instructions on how to find your OpenAI API key](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key)
- An [Auth0 FGA](https://fga.dev) account, or a running [OpenFGA](https://openfga.dev) instance.

### Setup the workspace `.env` file

Copy the `.env.example` file to `.env` and configure it for your FGA provider:

#### Auth0 FGA

Set up a new Authorized Client from the `Settings` page in the [Auth0 FGA Dashboard](https://dashboard.fga.dev) and fill in the following variables:

```sh
# OpenAI
OPENAI_API_KEY=xx-xxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxx

# Auth0 FGA
FGA_STORE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxx
FGA_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxx
FGA_CLIENT_SECRET=xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxx
# Required only for non-US regions
FGA_API_URL=https://api.xxx.fga.dev
FGA_API_AUDIENCE=https://api.xxx.fga.dev/
```

#### OpenFGA

You can configure OpenFGA using an API Token:

```sh
# OpenAI
OPENAI_API_KEY=xx-xxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenFGA
FGA_API_URL=http://localhost:8080
FGA_API_TOKEN=your-api-token
```

Or using Client Credentials. When using Client Credentials, set `FGA_API_TOKEN_ISSUER` to a non-`auth.fga.dev` issuer so the example treats the provider as OpenFGA:

```sh
# OpenAI
OPENAI_API_KEY=xx-xxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenFGA
FGA_API_URL=http://localhost:8080
FGA_API_TOKEN_ISSUER=https://your-openfga-issuer.example
FGA_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxx
FGA_CLIENT_SECRET=xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxx
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

## License

Apache-2.0
