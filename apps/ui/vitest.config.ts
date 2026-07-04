import { defineConfig } from "vitest/config";
import path from "node:path";

// Standalone test config — intentionally NOT the Lovable vite.config (which
// pulls the TanStack Start / nitro plugins). The Phase 1 suite covers pure
// modules under src/lib/metagraphed, so a plain node environment is enough.
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
