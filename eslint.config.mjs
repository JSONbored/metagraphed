import js from "@eslint/js";

export default [
  {
    ignores: [
      "node_modules/**",
      "packages/*/node_modules/**",
      "packages/*/dist/**",
      "packages/*/src/metagraphed-*.ts",
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
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
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
