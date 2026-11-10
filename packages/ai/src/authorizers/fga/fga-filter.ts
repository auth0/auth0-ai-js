import {
  ClientBatchCheckItem,
  ConsistencyPreference,
  OpenFgaClient,
} from "@openfga/sdk";

import { buildOpenFgaClient, FGAClientParams } from "./fga-client";

export type FGAFilterCheckerFn<T extends Record<string, any>> = (
  doc: T
) => ClientBatchCheckItem;

export type FGAFilterArgs<T extends Record<string, any>> = {
  buildQuery: FGAFilterCheckerFn<T>;
  consistency?: ConsistencyPreference;
};

/**
 * A filter that allows filtering documents based on access control checks
 * using OpenFGA. This class performs batch checks on passed documents,
 * returning only the ones that pass the specified access criteria.
 *
 * @remarks
 * The FGAFilter requires a buildQuery function to specify how access checks
 * are formed for each document, the checks are executed via an OpenFGA client
 * or equivalent mechanism. The checks are then mapped back to their corresponding
 * documents to filter out those for which access is denied.
 *
 * @example
 * ```ts
 * const filter = FGAFilter.create({
 *   buildQuery: (doc) => ({
 *     user: `user:${user}`,
 *     object: `doc:${doc.metadata.id}`,
 *     relation: "viewer",
 *   }),
 * });
 * ```
 */
export class FGAFilter<T extends Record<string, any>> {
  private buildQuery: FGAFilterCheckerFn<T>;
  private consistency: ConsistencyPreference;
  private fgaClient: OpenFgaClient;

  private constructor(
    { buildQuery, consistency }: FGAFilterArgs<T>,
    fgaClientParams?: FGAClientParams
  ) {
    this.buildQuery = buildQuery;
    this.consistency = consistency || ConsistencyPreference.HigherConsistency;
    this.fgaClient = buildOpenFgaClient(fgaClientParams);
  }

  /**
   * Creates a new FGAFilter instance using the given arguments and optional OpenFgaClient.
   *
   * @param args - @FGAFilterArgs
   * @param args.buildQuery - A function to generate access check requests for each document.
   * @param args.consistency - Optional - The consistency preference for the OpenFGA client.
   * @param fgaClientParams - Optional - OpenFgaClient configuration to execute checks against.
   * @returns A newly created FGAFilter instance configured with the provided arguments.
   */
  static create<T extends Record<string, any>>(
    args: FGAFilterArgs<T>,
    fgaClientParams?: FGAClientParams
  ): FGAFilter<T> {
    return new FGAFilter(args, fgaClientParams);
  }

  /**
   * Filters documents based on the provided query parameters, processes
   * them through a checker function,
   * and filters the documents based on permissions.
   *
   * @param params - The query parameters used to retrieve nodes.
   * @returns A promise that resolves to an array of documents that have passed the permission checks.
   */
  async filter(documents: T[]): Promise<T[]> {
    const { checks, documentToObject } = documents.reduce(
      (acc, doc) => {
        const check = this.buildQuery(doc);
        const checkKey = this.getCheckKey(check);
        acc.documentToObject.set(doc, checkKey);
        // Skip duplicate checks for same user, object, and relation
        if (!acc.seenChecks.has(checkKey)) {
          acc.seenChecks.add(checkKey);
          acc.checks.push(check);
        }
        return acc;
      },
      {
        checks: [] as ClientBatchCheckItem[],
        documentToObject: new Map<T, string>(),
        seenChecks: new Set<string>(),
      }
    );

    const permissionsMap = await this.checkPermissions(checks);

    return documents.filter(
      (d) => permissionsMap.get(documentToObject.get(d) || "") === true
    );
  }

  /**
   * Checks permissions for a list of client requests.
   *
   * @param checks - An array of `ClientBatchCheckItem` objects representing the permissions to be checked.
   * @returns A promise that resolves to a `Map` where the keys are object identifiers and the values are booleans indicating whether the permission is allowed.
   */
  private async checkPermissions(
    checks: ClientBatchCheckItem[]
  ): Promise<Map<string, boolean>> {
    const response = await this.fgaClient.batchCheck(
      { checks },
      {
        consistency: this.consistency,
      }
    );

    return response.result.reduce(
      (permissionMap: Map<string, boolean>, result) => {
        const checkKey = this.getCheckKey(result.request);
        permissionMap.set(checkKey, result.allowed || false);
        return permissionMap;
      },
      new Map<string, boolean>()
    );
  }

  private getCheckKey(check: ClientBatchCheckItem): string {
    // Include `context` and `contextualTuples` (both sent per check item in
    // BatchCheck) so checks that differ only by either are treated as
    // distinct and are neither incorrectly deduplicated nor correlated to the
    // wrong batch-check result. See GHSA-rcmp-9f79-cfm9.
    return `${check.user}|${check.object}|${check.relation}|${canonicalize(
      check.context
    )}|${canonicalize(check.contextualTuples)}`;
  }
}

/**
 * Produces a stable string for a `context` value: object keys are sorted at
 * every depth so two equal contexts share a key regardless of key order, while
 * any value difference — including deeply nested ones — yields a distinct key.
 *
 * @remarks
 * `JSON.stringify(context, Object.keys(context).sort())` is NOT a safe
 * substitute: its second argument is a property allowlist, not a sort order,
 * and applied recursively it drops every nested key, collapsing distinct
 * nested contexts to the same string. Array order is preserved because FGA
 * `list` context values are order-sensitive.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}
