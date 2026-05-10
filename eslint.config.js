import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";

export default defineConfig([
  globalIgnores([
    ".claude/",
    ".playwright/",
    ".pnpm-store/",
    ".sisyphus/",
    ".tmp/",
    "coverage/",
    "node_modules/",
    "reports/",
    "secrets/",
  ]),
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true, varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/ci/bootstrap-proton-session.mjs"],
    languageOptions: {
      globals: globals.browser,
    },
  },
]);
