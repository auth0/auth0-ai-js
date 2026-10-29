import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { documentPaths, guideNames, packageDir, snippetsOf } from "./guides.js";

/**
 * Every `ts` code block in the README and the guides is compiled against the package source. A
 * snippet that uses a name or a signature the package does not export fails here. The suite also
 * checks relative links, anchors and the wording rules of the documents.
 */

const snippets = documentPaths().flatMap((file) => snippetsOf(file));

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
      paths: { "@auth0/ai-fastmcp": ["src/index.ts"] },
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

  it("finds the documented code blocks and leaves no TypeScript block uncompiled", () => {
    expect(snippets.length).toBeGreaterThan(0);
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
      const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
      const messages = diagnostics.map((d) => {
        const position =
          d.file !== undefined && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
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
    "%s has no dashes used as punctuation and no exclamation marks in prose",
    (_name, file) => {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\u2013|\u2014/);
      expect(text).not.toMatch(/ -{2} /);
      const prose = text.replace(/^```[\s\S]*?^```$/gm, "").replace(/`[^`]*`/g, "");
      expect(prose).not.toContain("!");
    },
  );

  it("links every guide from the README", () => {
    const readme = readFileSync(path.join(packageDir, "README.md"), "utf8");
    const unlinked = guideNames().filter((name) => !readme.includes(`(./docs/${name}`));
    expect(unlinked).toEqual([]);
  });
});
