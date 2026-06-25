import { defineConfig } from "vitest/config";

const junitPath = process.env.VITEST_JUNIT_PATH;

export default defineConfig({
  test: {
    environment: "node",
    // `.claude/**` keeps gitignored agent worktrees (.claude/worktrees/*, each a
    // full repo copy with its own tests) from doubling the run + skewing coverage.
    exclude: ["node_modules/**", "private/**", ".claude/**"],
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
    reporters: junitPath ? ["default", "junit"] : ["default"],
    ...(junitPath ? { outputFile: { junit: junitPath } } : {}),
    coverage: {
      provider: "v8",
      // lcov for the Codecov upload (codecov/codecov-action reads
      // coverage/lcov.info); json-summary/text for local + CI readouts.
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "src/**/*.mjs",
        "workers/**/*.mjs",
        "scripts/{artifact-budgets,lib,openapi-components,registry-identity}.mjs",
      ],
      // BACKSTOP floors only — NOT the primary gate. The real PR coverage gate is
      // Codecov (delta-based project + patch coverage, see codecov.yml). That
      // avoids the fixed-pin churn where every PR must match a near-peak absolute
      // number and a single merge can push other open PRs below it. These floors
      // sit well under the achieved ~98% lines/stmts / ~90% branches, so a normal
      // PR never trips them; they only catch a catastrophic local regression
      // before push (and keep `npm run test:coverage` meaningful offline).
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 92,
        statements: 92,
      },
    },
  },
});
