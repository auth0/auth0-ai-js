import "dotenv/config";

import fs from "fs";
import path from "path";

import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";

// Persists the generated store id in .env, replacing an existing value when present.
function saveStoreId(storeId: string) {
  const envPath = path.join(__dirname, "..", ".env");
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf8");
  }
  const regex = /^FGA_STORE_ID=.*$/m;
  if (regex.test(content)) {
    content = content.replace(regex, `FGA_STORE_ID="${storeId}"`);
  } else {
    content += `\nFGA_STORE_ID="${storeId}"\n`;
  }
  fs.writeFileSync(envPath, content);
}

/**
 * Initializes the OpenFgaClient, writes an authorization model, and configures pre-defined tuples.
 *
 * This function performs the following steps:
 *    1. Creates an instance of OpenFgaClient with the necessary configuration.
 *    2. Writes an authorization model with specified schema version and type definitions.
 *    3. Configures pre-defined tuples using the newly created authorization model.
 */
async function main() {
  const hasApiToken = Boolean(process.env.FGA_API_TOKEN);
  const fgaTokenIssuer = process.env.FGA_API_TOKEN_ISSUER || "auth.fga.dev";
  const isAuth0FGA = !hasApiToken && fgaTokenIssuer === "auth.fga.dev";

  if (!process.env.FGA_STORE_ID && isAuth0FGA) {
    console.error(
      "Error: FGA_STORE_ID is required when using Auth0 FGA. Please set it in your .env file."
    );
    process.exit(1);
  }

  const credentials = hasApiToken
    ? {
        method: CredentialsMethod.ApiToken as const,
        config: {
          token: process.env.FGA_API_TOKEN,
        },
      }
    : {
        method: CredentialsMethod.ClientCredentials as const,
        config: {
          apiTokenIssuer: fgaTokenIssuer,
          apiAudience:
            process.env.FGA_API_AUDIENCE || "https://api.us1.fga.dev/",
          clientId: process.env.FGA_CLIENT_ID!,
          clientSecret: process.env.FGA_CLIENT_SECRET!,
        },
      };

  const apiUrl = process.env.FGA_API_URL || "https://api.us1.fga.dev";
  let storeId = process.env.FGA_STORE_ID;

  if (!storeId) {
    const tempClient = new OpenFgaClient({ apiUrl, credentials });
    const store = await tempClient.createStore({ name: "demo-store" });
    storeId = store.id!;
    saveStoreId(storeId);
    console.log("Created new FGA store:", storeId);
  }

  const fgaClient = new OpenFgaClient({
    apiUrl,
    storeId,
    credentials,
  });

  // 01. WRITE MODEL
  const dslContent = fs.readFileSync(
    path.join(__dirname, "model.fga"),
    "utf8"
  );
  const modelJson = transformer.transformDSLToJSONObject(dslContent);

  const model = await fgaClient.writeAuthorizationModel(modelJson);

  console.log("NEW MODEL ID: ", model.authorization_model_id);

  // 02. CONFIGURE PRE-DEFINED TUPLES
  await fgaClient.write(
    {
      writes: [
        { user: "user:*", relation: "viewer", object: "doc:public-doc" },
      ],
    },
    {
      authorizationModelId: model.authorization_model_id,
    }
  );
}

main().catch(console.error);
