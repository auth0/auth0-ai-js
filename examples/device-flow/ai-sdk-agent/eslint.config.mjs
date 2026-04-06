import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import path from "node:path";
import { includeIgnoreFile } from "@eslint/compat";

const gitIgnore = path.resolve(import.meta.dirname, ".gitignore");

/** @type {import('eslint').Linter.Config[]} */
export default [
  includeIgnoreFile(gitIgnore),
  { ignores: ["eslint.config.mjs"] },
  {
    files: ["src/*.{js,mjs,cjs,ts}"],
    languageOptions: { globals: globals.browser },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],

    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
