import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Every `ts` code block in the documentation is compiled against the package source.
 * A snippet that uses a name or signature the package does not export fails here.
 * The suite also checks relative links, anchors and wording rules of the documents.
 */

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

function documentPaths(): string[] {
  const docsDir = path.join(packageDir, "docs");
  const guides = readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(docsDir, name));
  return [
    path.join(packageDir, "README.md"),
    path.join(packageDir, "EXAMPLES.md"),
    ...guides,
  ];
}

interface Snippet {
  id: string;
  fileName: string;
  code: string;
}

function extractSnippets(): Snippet[] {
  const snippets: Snippet[] = [];
  for (const file of documentPaths()) {
    const relative = path.relative(packageDir, file);
    const text = readFileSync(file, "utf8");
    const pattern = /^```(?:ts|tsx|typescript)\n([\s\S]*?)^```$/gm;
    let index = 0;
    for (const match of text.matchAll(pattern)) {
      index += 1;
      const base = relative.replace(/[^A-Za-z0-9]+/g, "_");
      snippets.push({
        id: `${relative} block ${index}`,
        fileName: path.join(packageDir, "test", "docs", "__snippets__", `${base}_${index}.ts`),
        code: match[1] ?? "",
      });
    }
  }
  return snippets;
}

const snippets = extractSnippets();

describe("documentation snippets", () => {
  let program: ts.Program;
  const virtualFiles = new Map(snippets.map((s) => [s.fileName, s.code]));

  beforeAll(() => {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      isolatedModules: true,
      types: ["node"],
      typeRoots: [
        path.join(packageDir, "node_modules", "@types"),
        path.join(packageDir, "..", "..", "node_modules", "@types"),
      ],
      baseUrl: packageDir,
      paths: {
        "@auth0/ai-mcp": ["src/index.ts"],
        "@auth0/ai-mcp/mcp-sdk": ["src/mcp-sdk.ts"],
      },
    };
    const host = ts.createCompilerHost(options);
    const { fileExists, readFile, getSourceFile } = host;
    host.fileExists = (name) => virtualFiles.has(path.resolve(name)) || fileExists(name);
    host.readFile = (name) => virtualFiles.get(path.resolve(name)) ?? readFile(name);
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
      const virtual = virtualFiles.get(path.resolve(name));
      return virtual === undefined
        ? getSourceFile(name, languageVersion, onError, shouldCreate)
        : ts.createSourceFile(name, virtual, languageVersion, true);
    };
    program = ts.createProgram([...virtualFiles.keys()], options, host);
  }, 120_000);

  it("finds the documented code blocks", () => {
    expect(snippets.length).toBe(36);
    const fenceCount = documentPaths().reduce(
      (total, file) =>
        total + (readFileSync(file, "utf8").match(/^```(?:ts|tsx|typescript|js|jsx|javascript)$/gm) ?? []).length,
      0,
    );
    expect(fenceCount).toBe(snippets.length);
  });

  it.each(snippets.map((s) => [s.id, s.fileName] as const))(
    "%s compiles against the package",
    (_id, fileName) => {
      const source = program.getSourceFile(fileName);
      expect(source, "source file is part of the program").toBeDefined();
      const diagnostics = [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ];
      const messages = diagnostics.map((d) => {
        const position =
          d.file !== undefined && d.start !== undefined
            ? d.file.getLineAndCharacterOfPosition(d.start)
            : undefined;
        return `${position ? `${position.line + 1}:${position.character + 1} ` : ""}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
      });
      expect(messages).toEqual([]);
    },
    60_000,
  );
});

function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

function anchorsOf(text: string): Set<string> {
  const anchors = new Set<string>();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) anchors.add(slugify(match[1]));
  }
  return anchors;
}

describe("documentation structure", () => {
  const files = documentPaths();

  it.each(files.map((f) => [path.relative(packageDir, f), f] as const))(
    "%s has working relative links and anchors",
    (_name, file) => {
      const text = readFileSync(file, "utf8");
      const prose = text.replace(/^```[\s\S]*?^```$/gm, "");
      const broken: string[] = [];
      for (const match of prose.matchAll(/\]\((?!https?:|mailto:)([^)\s]+)\)/g)) {
        const target = match[1] ?? "";
        const [rawPath = "", anchor] = target.split("#");
        const resolved = rawPath === "" ? file : path.resolve(path.dirname(file), rawPath);
        if (!existsSync(resolved)) {
          broken.push(`${target} (missing file)`);
          continue;
        }
        if (anchor !== undefined && resolved.endsWith(".md")) {
          if (!anchorsOf(readFileSync(resolved, "utf8")).has(anchor)) {
            broken.push(`${target} (missing anchor)`);
          }
        }
      }
      expect(broken).toEqual([]);
    },
  );

  it.each(files.map((f) => [path.relative(packageDir, f), f] as const))(
    "%s has no dashes used as punctuation",
    (_name, file) => {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\u2013|\u2014/);
      expect(text).not.toMatch(/ -- /);
    },
  );
});

describe("documentation targets the MCP SDK v2", () => {
  it("compiled snippets import no v1 package", () => {
    const offenders = snippets
      .filter((s) => s.code.includes("@modelcontextprotocol/sdk"))
      .map((s) => s.id);
    expect(offenders).toEqual([]);
  });

  it("the install line names the v2 server package", () => {
    const readme = readFileSync(path.join(packageDir, "README.md"), "utf8");
    expect(readme).toContain("npm install @auth0/ai-mcp @modelcontextprotocol/server");
    expect(readme).not.toContain("npm install @auth0/ai-mcp @modelcontextprotocol/sdk");
  });

  it("keeps the v1 recipe as plain text so it is never compiled", () => {
    const handler = readFileSync(path.join(packageDir, "docs", "Handler.md"), "utf8");
    const section = handler.split("## Using the MCP SDK v1")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("WebStandardStreamableHTTPServerTransport");
    expect(section).toContain("unsupported");
    expect(section).not.toMatch(/^```ts$/m);
  });
});
