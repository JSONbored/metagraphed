import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["node_modules/**", "private/**"],
    // Run test FILES sequentially (each still in its own isolated fork). The
    // artifact-build tests (tests/artifacts.test.mjs) execFileSync the real
    // scripts/build-artifacts.mjs, which mutates the shared on-disk artifact
    // trees in place: it rm's + repopulates the R2 staging dir
    // (dist/metagraph-r2/metagraph, where R2-only artifacts such as
    // registry-summary.json live with NO committed public/metagraph fallback)
    // and writeFileSyncs forged JSON into committed public/metagraph files
    // before restoring them. Reader tests that serve those artifacts via
    // createLocalArtifactEnv (subnet-overview, mcp-server, api-coverage, …)
    // would otherwise race that rebuild and intermittently 404 (e.g.
    // GET /api/v1/registry/summary -> 404 instead of 200). The build output
    // root resolves from the script's own location, so it can't be redirected
    // to a temp dir without a full input+output tree copy — serializing files
    // is the clean, low-risk fix. Per-file fork isolation is preserved; only
    // filesystem-race concurrency is removed.
    fileParallelism: false,
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
