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
    // `tests/e2e/**/*.unit.ts` covers the e2e HARNESS itself -- helpers whose
    // logic decides whether the suite is trustworthy (see server-restart.ts,
    // which must retry a restarting server and must NOT retry a real failure).
    // Those live beside the specs they serve, but are plain node logic and
    // should not need a browser to test.
    //
    // `.unit.ts`, deliberately not `.test.ts`: playwright.config.ts sets
    // testDir to ./tests/e2e, and Playwright's default testMatch claims BOTH
    // *.spec.ts and *.test.ts -- so a .test.ts here would be collected by
    // Playwright as an e2e test with no test() calls in it.
    include: ["src/**/*.test.{ts,tsx}", "tests/e2e/**/*.unit.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
