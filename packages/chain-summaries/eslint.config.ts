import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

// This package must run unmodified in both a browser (apps/ui, via Vite) and
// a Cloudflare Worker (workers/, via wrangler's esbuild) -- the same runtime
// globals list root eslint.config.ts uses for workers/**+src/**, not
// packages/ui-kit's browser-only `globals.browser` (that package never runs
// in a Worker).
const runtimeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  atob: "readonly",
  btoa: "readonly",
  console: "readonly",
  crypto: "readonly",
  globalThis: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
};

export default tseslint.config(
  { ignores: ["dist"] },
  js.configs.recommended,
  {
    extends: [tseslint.configs.recommended],
    files: ["**/*.ts"],
    languageOptions: {
      globals: runtimeGlobals,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The whole point of this package (#8525) is that it's a real,
      // standalone, framework-free library both apps/ui and workers/ import
      // identically. Mirrors packages/ui-kit's own "app-logic import
      // guardrail" (packages/ui-kit/eslint.config.ts), scoped to what
      // actually threatens portability here: apps/ui itself, and any
      // React/DOM/router surface a Worker cannot provide.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              message:
                "packages/chain-summaries must run in a Cloudflare Worker with no DOM -- it cannot depend on React.",
            },
          ],
          patterns: [
            {
              group: ["**/apps/ui/**", "**/apps/ui"],
              message:
                "packages/chain-summaries must never import from apps/ui -- that's the app-context leak this package exists to prevent. Duplicate the needed pure logic here instead (see src/format.ts).",
            },
          ],
        },
      ],
    },
  },
  eslintPluginPrettier,
);
