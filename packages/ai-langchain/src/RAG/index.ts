import { z } from "zod/v3";

import { Document, DocumentInterface } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import { StructuredToolInterface, tool } from "@langchain/core/tools";
import { ClientBatchCheckItem, ConsistencyPreference } from "@openfga/sdk";
import { FGAFilter, FGAClientParams } from "@auth0/ai";
import type { BaseRetrieverInput } from "@langchain/core/retrievers";
import type { CallbackManagerForRetrieverRun } from "@langchain/core/callbacks/manager";
export type FGARetrieverCheckerFn = (
  doc: DocumentInterface<Record<string, any>>
) => ClientBatchCheckItem;

export type FGARetrieverArgs = {
  retriever: BaseRetriever;
  buildQuery: FGARetrieverCheckerFn;
  consistency?: ConsistencyPreference;
  retrieverFields?: BaseRetrieverInput;
};

/**
 * A retriever that allows filtering documents based on access control checks
 * using OpenFGA. This class wraps an underlying retriever and performs batch
 * checks on retrieved documents, returning only the ones that pass the
 * specified access criteria.
 *
 * @remarks
 * The FGARetriever requires a buildQuery function to specify how access checks
 * are formed for each document, the checks are executed via an OpenFGA client
 * or equivalent mechanism. The checks are then mapped back to their corresponding
 * documents to filter out those for which access is denied.
 *
 * @example
 * ```ts
 * const retriever = FGARetriever.create({
 *   retriever: someOtherRetriever,
 *   buildQuery: (doc) => ({
 *     user: `user:${user}`,
 *     object: `doc:${doc.metadata.id}`,
 *     relation: "viewer",
 *   }),
 * });
 * ```
 */
export class FGARetriever extends BaseRetriever {
  lc_namespace = ["@langchain", "retrievers"];
  private retriever: BaseRetriever;

  private fgaFilter: FGAFilter<DocumentInterface<Record<string, any>>>;

  private constructor(
    { buildQuery, retriever, consistency, retrieverFields }: FGARetrieverArgs,
    fgaClientParams?: FGAClientParams
  ) {
    super(retrieverFields);
    this.fgaFilter = FGAFilter.create(
      {
        buildQuery,
        consistency,
      },
      fgaClientParams
    );
    this.retriever = retriever;
  }

  /**
   * Creates a new FGARetriever instance using the given arguments and optional OpenFgaClient.
   *
   * @param args - @FGARetrieverArgs
   * @param args.retriever - The underlying retriever instance to fetch documents.
   * @param args.buildQuery - A function to generate access check requests for each document.
   * @param args.consistency - Optional - The consistency preference for the OpenFGA client.
   * @param args.retrieverFields - Optional - Additional fields to pass to the underlying retriever.
   * @param fgaClientParams - Optional - OpenFgaClient configuration to execute checks against.
   * @returns A newly created FGARetriever instance configured with the provided arguments.
   */
  static create(
    args: FGARetrieverArgs,
    fgaClientParams?: FGAClientParams
  ): FGARetriever {
    return new FGARetriever(args, fgaClientParams);
  }

  /**
   * Retrieves documents based on the provided query parameters, processes
   * them through a checker function,
   * and filters the documents based on permissions.
   *
   * @param params - The query parameters used to retrieve nodes.
   * @returns A promise that resolves to an array of documents that have passed the permission checks.
   */
  async _getRelevantDocuments(
    query: string,
    runManager?: CallbackManagerForRetrieverRun
  ): Promise<Document[]> {
    const documents = await this.retriever._getRelevantDocuments(
      query,
      runManager
    );

    const result = await this.fgaFilter.filter(documents);
    return result;
  }

  /**
   * Converts the FGA retriever into a tool that can be used by a LangGraph agent.
   * @returns StructuredToolInterface.
   */
  asJoinedStringTool(): StructuredToolInterface {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const retriever = this;
    return tool(
      async ({ query }) => {
        const documents = await retriever.invoke(query);
        return documents.map((doc) => doc.pageContent).join("\n\n");
      },
      {
        name: "fga-retriever-tool",
        description: "Returns the filtered documents page content as string.",
        schema: z.object({ query: z.string() }),
      }
    );
  }
}
