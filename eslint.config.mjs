import js from "@eslint/js";

export default [
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
      globals: {
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
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
