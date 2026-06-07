import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["node_modules/**", "private/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/**/*.mjs",
        "workers/**/*.mjs",
        "scripts/{artifact-budgets,lib,openapi-components,submission-notifications,submission-policy}.mjs",
      ],
      thresholds: {
        branches: 85,
        functions: 95,
        lines: 97,
        statements: 97,
      },
    },
  },
});
