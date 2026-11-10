import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientBatchCheckItem, OpenFgaClient } from "@openfga/sdk";

import { FGAFilter } from "../src/authorizers/fga/fga-filter";

vi.mock("@openfga/sdk", () => {
  return {
    OpenFgaClient: vi.fn().mockImplementation(() => ({
      batchCheck: vi.fn(),
    })),
    ConsistencyPreference: {
      HigherConsistency: "HIGHER_CONSISTENCY",
    },
    CredentialsMethod: {
      ClientCredentials: "client_credentials",
    },
  };
});

type Doc = {
  id: string;
  user: string;
  object: string;
  relation: string;
  context?: Record<string, any>;
  contextualTuples?: ClientBatchCheckItem["contextualTuples"];
};

describe("FGAFilter", () => {
  const mockBatchCheck = vi.fn();
  const MockedOpenFgaClient = OpenFgaClient as any;

  beforeEach(() => {
    MockedOpenFgaClient.mockImplementation(() => ({
      batchCheck: mockBatchCheck,
    }));

    process.env.FGA_STORE_ID = "test_store_id";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockBatchCheck.mockReset();
  });

  /**
   * A stand-in for the FGA service: it authorizes each *distinct* check on its
   * own merits. Here access is granted only when the check carries
   * `context.authorized === true`. Crucially, it echoes back the exact request
   * it received, exactly as the real batchCheck response does, so the filter is
   * responsible for correlating each result to the right document.
   */
  const mockBatchCheckByContext = ({
    checks,
  }: {
    checks: ClientBatchCheckItem[];
  }) =>
    Promise.resolve({
      result: checks.map((check) => ({
        request: check,
        allowed: (check.context as any)?.authorized === true,
      })),
    });

  const buildQuery = (doc: Doc): ClientBatchCheckItem => ({
    user: doc.user,
    object: doc.object,
    relation: doc.relation,
    ...(doc.context ? { context: doc.context } : {}),
    ...(doc.contextualTuples ? { contextualTuples: doc.contextualTuples } : {}),
  });

  describe("when two documents share user/object/relation but differ by context", () => {
    // Regression test for GHSA-rcmp-9f79-cfm9: an incomplete check key
    // (user|object|relation, ignoring `context`) collapsed these two checks
    // into one during dedup and correlated both documents to the single
    // returned result, leaking the denied document.
    let result: Doc[];

    const allowedDoc: Doc = {
      id: "allowed",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      context: { authorized: true },
    };
    const deniedDoc: Doc = {
      id: "denied",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      context: { authorized: false },
    };

    beforeEach(async () => {
      mockBatchCheck.mockImplementation(mockBatchCheckByContext);
      const filter = FGAFilter.create<Doc>({ buildQuery });
      result = await filter.filter([allowedDoc, deniedDoc]);
    });

    it("sends both checks to FGA instead of deduplicating them away", () => {
      const { checks } = mockBatchCheck.mock.calls[0][0];
      expect(checks).toHaveLength(2);
    });

    it("returns the authorized document", () => {
      expect(result).toContain(allowedDoc);
    });

    it("filters out the denied document", () => {
      expect(result).not.toContain(deniedDoc);
    });
  });

  describe("when two documents differ only by a nested context value", () => {
    // Regression for the nested-context variant of GHSA-rcmp-9f79-cfm9.
    // A key built with `JSON.stringify(context, Object.keys(context).sort())`
    // uses the second argument as a property allowlist, which drops every
    // *nested* key — so `{dept:{level:5}}` and `{dept:{level:2}}` both collapse
    // to `{"dept":{}}`, share a key, and leak the denied document. The key must
    // canonicalize context recursively.
    let result: Doc[];

    const allowedDoc: Doc = {
      id: "allowed",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      context: { dept: { level: 5, region: "us" } },
    };
    const deniedDoc: Doc = {
      id: "denied",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      context: { dept: { level: 2, region: "us" } },
    };

    beforeEach(async () => {
      // Authorize only when the nested department level is 5.
      mockBatchCheck.mockImplementation(
        ({ checks }: { checks: ClientBatchCheckItem[] }) =>
          Promise.resolve({
            result: checks.map((check) => ({
              request: check,
              allowed: (check.context as any)?.dept?.level === 5,
            })),
          })
      );
      const filter = FGAFilter.create<Doc>({ buildQuery });
      result = await filter.filter([allowedDoc, deniedDoc]);
    });

    it("sends both checks to FGA instead of collapsing the nested contexts", () => {
      const { checks } = mockBatchCheck.mock.calls[0][0];
      expect(checks).toHaveLength(2);
    });

    it("returns the authorized document", () => {
      expect(result).toContain(allowedDoc);
    });

    it("filters out the denied document", () => {
      expect(result).not.toContain(deniedDoc);
    });
  });

  describe("when two documents differ only by contextual tuples", () => {
    // BatchCheck sends `contextualTuples` per check item, so two checks that
    // share user/object/relation/context but carry different contextual tuples
    // can be decided differently and must not share a key.
    let result: Doc[];

    const allowedDoc: Doc = {
      id: "allowed",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      contextualTuples: {
        tuple_keys: [
          { user: "user:jane", relation: "member", object: "group:public" },
        ],
      },
    };
    const deniedDoc: Doc = {
      id: "denied",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      contextualTuples: {
        tuple_keys: [
          { user: "user:jane", relation: "member", object: "group:secret" },
        ],
      },
    };

    beforeEach(async () => {
      // Authorize only when a contextual tuple places the user in group:public.
      mockBatchCheck.mockImplementation(
        ({ checks }: { checks: ClientBatchCheckItem[] }) =>
          Promise.resolve({
            result: checks.map((check) => ({
              request: check,
              allowed: (check.contextualTuples?.tuple_keys ?? []).some(
                (t) => t.object === "group:public"
              ),
            })),
          })
      );
      const filter = FGAFilter.create<Doc>({ buildQuery });
      result = await filter.filter([allowedDoc, deniedDoc]);
    });

    it("sends both checks to FGA instead of deduplicating them away", () => {
      const { checks } = mockBatchCheck.mock.calls[0][0];
      expect(checks).toHaveLength(2);
    });

    it("returns the authorized document", () => {
      expect(result).toContain(allowedDoc);
    });

    it("filters out the denied document", () => {
      expect(result).not.toContain(deniedDoc);
    });
  });

  describe("when contextual tuples differ only by their condition context", () => {
    // The tuple itself is identical; only the condition parameters attached to
    // it differ, which can still change the decision.
    let result: Doc[];

    const tupleWithLevel = (level: number) => ({
      tuple_keys: [
        {
          user: "user:jane",
          relation: "member",
          object: "group:eng",
          condition: { name: "min_level", context: { level } },
        },
      ],
    });

    const allowedDoc: Doc = {
      id: "allowed",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      contextualTuples: tupleWithLevel(5),
    };
    const deniedDoc: Doc = {
      id: "denied",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      contextualTuples: tupleWithLevel(2),
    };

    beforeEach(async () => {
      // Authorize only when the tuple's condition context has level 5.
      mockBatchCheck.mockImplementation(
        ({ checks }: { checks: ClientBatchCheckItem[] }) =>
          Promise.resolve({
            result: checks.map((check) => ({
              request: check,
              allowed: (check.contextualTuples?.tuple_keys ?? []).some(
                (t) => (t.condition?.context as any)?.level === 5
              ),
            })),
          })
      );
      const filter = FGAFilter.create<Doc>({ buildQuery });
      result = await filter.filter([allowedDoc, deniedDoc]);
    });

    it("sends both checks to FGA instead of deduplicating them away", () => {
      const { checks } = mockBatchCheck.mock.calls[0][0];
      expect(checks).toHaveLength(2);
    });

    it("filters out the denied document", () => {
      expect(result).toEqual([allowedDoc]);
    });
  });

  describe("when two documents produce a fully identical check", () => {
    // The dedup optimization must be preserved: checks that are identical in
    // every dimension (including context) are still sent to FGA only once.
    let result: Doc[];

    const docA: Doc = {
      id: "a",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      context: { authorized: true },
    };
    const docB: Doc = {
      id: "b",
      user: "user:jane",
      object: "doc:budget",
      relation: "viewer",
      context: { authorized: true },
    };

    beforeEach(async () => {
      mockBatchCheck.mockImplementation(mockBatchCheckByContext);
      const filter = FGAFilter.create<Doc>({ buildQuery });
      result = await filter.filter([docA, docB]);
    });

    it("deduplicates the identical checks into a single batch-check item", () => {
      const { checks } = mockBatchCheck.mock.calls[0][0];
      expect(checks).toHaveLength(1);
    });

    it("returns both documents when the shared check is allowed", () => {
      expect(result).toContain(docA);
      expect(result).toContain(docB);
    });
  });

  describe("when checks differ by object and carry no context", () => {
    // Baseline: the ordinary case (distinct objects, no conditional context)
    // still filters correctly.
    let result: Doc[];

    const allowedDoc: Doc = {
      id: "allowed",
      user: "user:jane",
      object: "doc:public",
      relation: "viewer",
    };
    const deniedDoc: Doc = {
      id: "denied",
      user: "user:jane",
      object: "doc:secret",
      relation: "viewer",
    };

    beforeEach(async () => {
      // Authorize by object: only doc:public is viewable.
      mockBatchCheck.mockImplementation(
        ({ checks }: { checks: ClientBatchCheckItem[] }) =>
          Promise.resolve({
            result: checks.map((check) => ({
              request: check,
              allowed: check.object === "doc:public",
            })),
          })
      );
      const filter = FGAFilter.create<Doc>({ buildQuery });
      result = await filter.filter([allowedDoc, deniedDoc]);
    });

    it("returns only the authorized document", () => {
      expect(result).toEqual([allowedDoc]);
    });
  });
});
