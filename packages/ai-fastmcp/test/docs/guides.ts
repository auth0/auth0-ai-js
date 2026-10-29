/**
 * Shared helpers of the documentation suites: where the documents live, how their code blocks
 * are read, and a check that a guide says what a test has just verified.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";

export const packageDir = fileURLToPath(new URL("../..", import.meta.url));
export const docsDir = path.join(packageDir, "docs");

/** File names of the guides under `docs`, sorted. */
export function guideNames(): string[] {
  if (!existsSync(docsDir)) return [];
  return readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

/** The README and every guide, as absolute paths. */
export function documentPaths(): string[] {
  return [path.join(packageDir, "README.md"), ...guideNames().map((name) => path.join(docsDir, name))];
}

/** The text of a guide (`"Errors.md"`) or of the README (`"README.md"`). */
export function guideText(name: string): string {
  const file = name === "README.md" ? path.join(packageDir, name) : path.join(docsDir, name);
  return readFileSync(file, "utf8");
}

export interface Snippet {
  id: string;
  /** Path the snippet is compiled as. The file does not exist on disk. */
  fileName: string;
  code: string;
}

const TS_FENCE = /^```(?:ts|tsx|typescript)\n([\s\S]*?)^```$/gm;

/** The fenced TypeScript blocks of a document, in order. */
export function snippetsOf(file: string): Snippet[] {
  const relative = path.relative(packageDir, file);
  const base = relative.replace(/[^A-Za-z0-9]+/g, "_");
  const snippets: Snippet[] = [];
  let index = 0;
  for (const match of readFileSync(file, "utf8").matchAll(TS_FENCE)) {
    index += 1;
    snippets.push({
      id: `${relative} block ${index}`,
      fileName: path.join(packageDir, "test", "docs", "__snippets__", `${base}_${index}.ts`),
      code: match[1] ?? "",
    });
  }
  return snippets;
}

/** The code of the `index`th (1-based) TypeScript block of a guide. */
export function snippetCode(name: string, index: number): string {
  const file = name === "README.md" ? path.join(packageDir, name) : path.join(docsDir, name);
  const snippet = snippetsOf(file)[index - 1];
  if (snippet === undefined) throw new Error(`${name} has no TypeScript block ${index}.`);
  return snippet.code;
}

/**
 * Asserts that the guide contains each text exactly as given. A behavior test calls this next to
 * the assertion on the real value, so the guide cannot keep a message, number or default that the
 * test no longer pins, and the test cannot drift from what the guide says.
 */
export function documented(name: string, ...needles: string[]): void {
  const text = guideText(name);
  for (const needle of needles) {
    expect(text, `${name} should contain: ${needle}`).toContain(needle);
  }
}

const generatedDir = path.join(packageDir, "test", "docs", "__generated__");

export interface LoadedSnippet {
  exports: Record<string, unknown>;
  /** Removes the generated file. */
  dispose(): void;
}

/**
 * Runs a documented block for real. The block is written next to the tests with three changes
 * that keep the run local: the import of `@auth0/ai-fastmcp` points at the source, each `rewrites`
 * pair is applied to the text, and the names in `exportNames` are exported so the test can reach
 * them. Everything else, the calls and their order, is the text of the guide.
 */
export async function loadSnippet(
  name: string,
  index: number,
  options: { rewrites?: Array<[string, string]>; exportNames: string[] },
): Promise<LoadedSnippet> {
  let code = snippetCode(name, index);
  for (const [from, to] of options.rewrites ?? []) {
    if (!code.includes(from)) throw new Error(`The block does not contain ${from}.`);
    code = code.replaceAll(from, to);
  }
  const missing = options.exportNames.filter((name) => !new RegExp(`export\\s+(?:const|let|var|function|class)\\s+${name}\\b`).test(code));
  if (missing.length > 0) code += `\nexport { ${missing.join(", ")} };\n`;
  // Each run gets its own directory, because spec files run in parallel workers.
  const runDir = path.join(generatedDir, `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, `${name.replace(/\W+/g, "_")}_${index}.ts`);
  const source = path.relative(runDir, path.join(packageDir, "src", "index.js")).split(path.sep).join("/");
  code = code.replaceAll('"@auth0/ai-fastmcp"', JSON.stringify(source));
  writeFileSync(file, code);
  const dispose = () => {
    rmSync(runDir, { recursive: true, force: true });
    try {
      rmdirSync(generatedDir);
    } catch {
      // Another run still uses the directory, or it is already gone.
    }
  };
  try {
    const exports = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
    return { exports, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
