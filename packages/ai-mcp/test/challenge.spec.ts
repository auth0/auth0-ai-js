import { describe, expect, it } from "vitest";
import {
  buildWwwAuthenticate,
  sanitizeChallengeValue,
} from "../src/challenge.js";
import type { ChallengeOptions } from "../src/challenge.js";

const PRM = "https://mcp.example.com/.well-known/oauth-protected-resource";

interface Case {
  name: string;
  options: ChallengeOptions;
  expected: string[];
}

const cases: Case[] = [
  {
    name: "missing credential: bare scheme, no error parameter",
    options: { schemes: ["Bearer"] },
    expected: ["Bearer"],
  },
  {
    name: "missing credential with realm and metadata carries no error parameters",
    options: { schemes: ["Bearer"], realm: "mcp", resourceMetadata: PRM },
    expected: [`Bearer realm="mcp", resource_metadata="${PRM}"`],
  },
  {
    name: "invalid token",
    options: {
      schemes: ["Bearer"],
      error: "invalid_token",
      errorDescription: "The access token is invalid or has expired.",
      resourceMetadata: PRM,
    },
    expected: [
      `Bearer error="invalid_token", error_description="The access token is invalid or has expired.", resource_metadata="${PRM}"`,
    ],
  },
  {
    name: "malformed request",
    options: {
      schemes: ["Bearer"],
      error: "invalid_request",
      errorDescription: "The request is malformed.",
    },
    expected: [
      'Bearer error="invalid_request", error_description="The request is malformed."',
    ],
  },
  {
    name: "insufficient scope lists the scopes",
    options: {
      schemes: ["Bearer"],
      error: "insufficient_scope",
      scope: ["tools:read", "tools:write"],
    },
    expected: [
      'Bearer error="insufficient_scope", scope="tools:read tools:write"',
    ],
  },
  {
    name: "empty scope list is omitted",
    options: { schemes: ["Bearer"], error: "insufficient_scope", scope: [] },
    expected: ['Bearer error="insufficient_scope"'],
  },
  {
    name: "realm on",
    options: { schemes: ["Bearer"], realm: "my realm", error: "invalid_token" },
    expected: ['Bearer realm="my realm", error="invalid_token"'],
  },
  {
    name: "realm that sanitizes to nothing is omitted",
    options: { schemes: ["Bearer"], realm: '"\\' },
    expected: ["Bearer"],
  },
  {
    name: "DPoP alone advertises the default algorithm",
    options: { schemes: ["DPoP"] },
    expected: ['DPoP algs="ES256"'],
  },
  {
    name: "DPoP with custom algorithms and an error",
    options: {
      schemes: ["DPoP"],
      dpopAlgs: ["ES256", "ES384"],
      error: "invalid_dpop_proof",
    },
    expected: ['DPoP error="invalid_dpop_proof", algs="ES256 ES384"'],
  },
  {
    name: "both schemes without a credential: neither carries an error",
    options: { schemes: ["Bearer", "DPoP"], realm: "mcp" },
    expected: ['Bearer realm="mcp"', 'DPoP realm="mcp", algs="ES256"'],
  },
  {
    name: "both schemes: the error goes to the first scheme by default",
    options: { schemes: ["Bearer", "DPoP"], error: "invalid_token" },
    expected: ['Bearer error="invalid_token"', 'DPoP algs="ES256"'],
  },
  {
    name: "both schemes: the error goes to the scheme the request used",
    options: {
      schemes: ["Bearer", "DPoP"],
      error: "invalid_token",
      errorScheme: "DPoP",
      resourceMetadata: PRM,
    },
    expected: [
      `Bearer resource_metadata="${PRM}"`,
      `DPoP error="invalid_token", algs="ES256", resource_metadata="${PRM}"`,
    ],
  },
  {
    name: "an error scheme that is not advertised falls back to the first scheme",
    options: {
      schemes: ["DPoP"],
      error: "invalid_request",
      errorScheme: "Bearer",
    },
    expected: ['DPoP error="invalid_request", algs="ES256"'],
  },
  {
    name: "description that sanitizes to nothing is omitted",
    options: {
      schemes: ["Bearer"],
      error: "invalid_token",
      errorDescription: '"\\\n',
    },
    expected: ['Bearer error="invalid_token"'],
  },
  {
    name: "quote and backslash are stripped from description",
    options: {
      schemes: ["Bearer"],
      error: "invalid_token",
      errorDescription: 'say "hi" \\ there',
    },
    expected: [
      'Bearer error="invalid_token", error_description="say hi  there"',
    ],
  },
  {
    name: "control characters and non-ASCII are dropped from description",
    options: {
      schemes: ["Bearer"],
      error: "invalid_token",
      errorDescription: "a\r\nb\tc\u0000d\u007feéf g",
    },
    expected: ['Bearer error="invalid_token", error_description="abcdefg"'],
  },
  {
    name: "header injection through realm is neutralized",
    options: { schemes: ["Bearer"], realm: 'x"\r\nSet-Cookie: a=b' },
    expected: ['Bearer realm="xSet-Cookie: a=b"'],
  },
  {
    name: "scope tokens are sanitized and cannot contain spaces",
    options: {
      schemes: ["Bearer"],
      error: "insufficient_scope",
      scope: ['a"b', "c d", "\\", "e"],
    },
    expected: ['Bearer error="insufficient_scope", scope="ab cd e"'],
  },
  {
    name: "resource metadata is sanitized",
    options: {
      schemes: ["Bearer"],
      resourceMetadata: 'https://x.example/"a\\b',
    },
    expected: ['Bearer resource_metadata="https://x.example/ab"'],
  },
];

describe("buildWwwAuthenticate", () => {
  it.each(cases)("$name", ({ options, expected }) => {
    expect(buildWwwAuthenticate(options)).toEqual(expected);
  });

  it("never writes an error parameter unless an error is given", () => {
    const values = buildWwwAuthenticate({
      schemes: ["Bearer", "DPoP"],
      errorDescription: "ignored without an error",
      scope: ["a"],
      realm: "r",
      resourceMetadata: PRM,
    });
    for (const value of values) {
      expect(value).not.toContain("error");
      expect(value).not.toContain("scope=");
    }
  });

  it("rejects an empty scheme list", () => {
    expect(() => buildWwwAuthenticate({ schemes: [] })).toThrow(TypeError);
  });
});

describe("sanitizeChallengeValue", () => {
  it("keeps every allowed character", () => {
    const allowed = ` !#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_\`abcdefghijklmnopqrstuvwxyz{|}~`;
    expect(sanitizeChallengeValue(allowed)).toBe(allowed);
  });

  it("removes quote, backslash, DEL and C0 controls", () => {
    const forbidden = `"\\\u007f${Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("")}`;
    expect(sanitizeChallengeValue(`a${forbidden}b`)).toBe("ab");
  });
});
