import { defineConfig } from "vitest/config";
import path from "node:path";

// Standalone test config — intentionally NOT the Lovable vite.config (which
// pulls the TanStack Start / nitro plugins). The Phase 1 suite covers pure
// modules under src/lib/metagraphed, so a plain node environment is enough.
export default defineConfig({
  test: {
    environment: "node",
    // .test.tsx alongside .test.ts -- a handful of tests render pure
    // JSX (context/wrapper components) via react-dom/server's
    // renderToStaticMarkup, which needs no DOM. Still no jsdom/testing-
    // library: SSR-rendering is enough to exercise hooks/context without
    // a browser environment, in keeping with this suite's "plain node is
    // enough" scope -- real component/interaction behavior stays covered
    // by the separate Playwright e2e suite.
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
