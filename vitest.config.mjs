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
      // Locked in after the coverage push (global ~98.7% stmts/lines, 92.7%
      // branches). Gates below the achieved level so coverage can't silently
      // regress past the 97%+ bar.
      thresholds: {
        branches: 90,
        functions: 97,
        lines: 98,
        statements: 98,
      },
    },
  },
});
