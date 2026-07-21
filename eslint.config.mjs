import js from "@eslint/js";
import tseslint from "typescript-eslint";

const runtimeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  CompressionStream: "readonly",
  CountQueuingStrategy: "readonly",
  Headers: "readonly",
  ReadableStream: "readonly",
  Request: "readonly",
  Response: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  atob: "readonly",
  btoa: "readonly",
  console: "readonly",
  crypto: "readonly",
  fetch: "readonly",
  globalThis: "readonly",
  performance: "readonly",
  process: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  WebSocket: "readonly",
  WebSocketPair: "readonly",
  structuredClone: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "packages/*/node_modules/**",
      "packages/*/dist/**",
      "packages/*/src/metagraphed-*.ts",
      // apps/ui has its own eslint.config.js scoped to its own React/TS setup —
      // this repo's root config has no TSX/JSX parser wired in and would just
      // error on syntax it can't parse, not meaningfully lint it.
      "apps/ui/**",
      // packages/ui-kit has its own eslint.config.js + tsconfig.json; packages/client
      // has its own tsconfig.json. Linting either from here creates a multi-root
      // tsconfig ambiguity for the TS parser (typescript-eslint can't tell which
      // tsconfig.json is authoritative for a file under two candidate roots).
      "packages/client/**",
      "packages/ui-kit/**",
      // wrangler-generated Env/runtime types (npm run types:workers) -- never
      // hand-edited; wrangler's own codegen ships its own eslint-disable
      // comments that this repo's config doesn't need to weigh in on.
      "workers/worker-configuration.d.ts",
      "workers/data-api.worker-configuration.d.ts",
      "workers/registry-sync-api.worker-configuration.d.ts",
      "public/metagraph/**",
      "registry/candidates/generated/**",
      "registry/subnets/generated/**",
      "registry/verification/**",
      "registry/adapters/latest/**",
      "private/**",
      "ops/private/**",
      "tmp/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: runtimeGlobals,
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: runtimeGlobals,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
