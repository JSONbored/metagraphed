import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirrors apps/ui/vitest.config.ts -- pure-module suite, plain node
// environment, matching the same `@` -> src alias as tsconfig.json.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
