/**
 * GenKit Example: Rerankers with Auth0 FGA/OpenFGA (Fine-Grained Authorization)
 *
 *
 */
import "dotenv/config";

import { z } from "genkit";

import { FGAReranker } from "@auth0/ai-genkit";

import { documentsRetriever, executeQuery, initializeGenkit } from "./helpers";

/**
 * Demonstrates the usage of the Auth0 FGA/OpenFGA (Fine-Grained Authorization)
 * with a vector store index to query documents with permission checks.
 *
 * The FGAReranker checks if the user has the "viewer" relation to the document
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
    "\n..:: GenKit Example: Reranker with Auth0 FGA/OpenFGA (Fine-Grained Authorization)\n\n"
  );

  // initialize a GenKit instance
  const ai = initializeGenkit();

  // UserID
  const user = "user1";

  // 1. Create an FGAReranker instance to check the permissions of the user.
  const fgaReranker = FGAReranker.create({
    ai,
    // FGA tuple to query for the user's permissions
    buildQuery: (doc) => ({
      user: `user:${user}`,
      object: `doc:${doc.metadata?.id}`,
      relation: "viewer",
    }),
  });

  // 2. Define a flow that retrieves and reranks documents.
  const demoFlow = ai.defineFlow(
    { name: "demo", inputSchema: z.string(), outputSchema: z.string() },
    async (query: string) => {
      // 3. Retrieve documents from the in-memory vector store
      const documents = await ai.retrieve({
        retriever: documentsRetriever,
        query,
      });
      // 4. Rerank the documents based on the user's permissions
      const rerankedDocuments = await ai.rerank({
        reranker: fgaReranker,
        query,
        documents,
      });
      // 5. Execute the query with the reranked documents as context
      return await executeQuery(ai, query, rerankedDocuments);
    }
  );

  /**
   * Output: `The provided context does not include any forecast...`
   */
  console.log(await demoFlow("Show me forecast for ZEKO?"));

  /**
   * If we add the following tuple to the Auth0 FGA/OpenFGA:
   *
   *    { user: "user:user1", relation: "viewer", object: "doc:private-doc" }
   *
   * Then, the output will be: `The forecast for Zeko Advanced Systems Inc. (ZEKO) for fiscal year 2025...`
   */
}

main().catch(console.error);
