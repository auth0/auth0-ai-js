/**
 * LlamaIndex Example: Retrievers with Auth0 FGA/OpenFGA (Fine-Grained Authorization)
 *
 *
 */
import "dotenv/config";

import { VectorStoreIndex } from "llamaindex";
import { FGARetriever } from "@auth0/ai-llamaindex";

import { readDocuments } from "./helpers/read-documents";

/**
 * Demonstrates the usage of the Auth0 FGA/OpenFGA (Fine-Grained Authorization)
 * with a vector store index to query documents with permission checks.
 *
 * It performs the following steps:
 *    1. Defines a user ID.
 *    2. Reads documents from a data source.
 *    3. Creates a VectorStoreIndex from the documents.
 *    4. Sets up a query engine with an FGARetriever to enforce permissions.
 *    5. Executes a query and logs the response.
 *
 * The FGARetriever checks if the user has the "viewer" relation to the document
 * based on predefined tuples in Auth0 FGA/OpenFGA.
 *
 * Example:
 * - A tuple {user: "user:*", relation: "viewer", object: "doc:public-doc"} allows all users to view "public-doc".
 * - A tuple {user: "user:user1", relation: "viewer", object: "doc:private-doc"} allows "user1" to view "private-doc".
 *
 * The output of the query depends on the user's permissions to view the documents.
 */
async function main() {
  console.log(
    "\n..:: LlamaIndex Example: Retrievers with Auth0 FGA/OpenFGA (Fine-Grained Authorization)\n\n"
  );

  // UserID
  const user = "user1";
  const documents = await readDocuments();
  const vectorStoreIndex = await VectorStoreIndex.fromDocuments(documents);

  const queryEngine = vectorStoreIndex.asQueryEngine({
    // Decorate the retriever with the FGARetriever to check the permissions.
    retriever: FGARetriever.create({
      retriever: vectorStoreIndex.asRetriever(),
      buildQuery: (document) => ({
        user: `user:${user}`,
        object: `doc:${document.node.metadata.id}`,
        relation: "viewer",
      }),
    }),
  });

  const vsiResponse = await queryEngine.query({
    query: "Show me forecast for ZEKO?",
  });

  /**
   * Output: `The provided document does not contain any specific forecast information...`
   */
  console.log(vsiResponse.toString());

  /**
   * If we add the following tuple to the Auth0 FGA/OpenFGA:
   *
   *    { user: "user:user1", relation: "viewer", object: "doc:private-doc" }
   *
   * Then, the output will be: `The forecast for Zeko Advanced Systems Inc. (ZEKO) for fiscal year 2025...`
   */
}

main().catch(console.error);
