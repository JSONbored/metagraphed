import { defineConfig } from "vitest/config";

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
    //
    // This serial default keeps the all-files entrypoints (`npm test`,
    // `npm run test:coverage`) race-proof. CI splits the run for speed instead
    // (this serialization was ~60% of the test wall-clock): `test:readers` runs
    // every suite EXCEPT artifacts.test.mjs with --fileParallelism (the
    // read-only suites are safe to parallelize — verified 5/5 green), and
    // `test:builders` runs artifacts.test.mjs alone, serial. They are separate
    // processes, so the builder never overlaps a reader. INVARIANT:
    // artifacts.test.mjs is the ONLY suite that mutates the shared
    // public/metagraph + R2 trees; any new suite that does the same must move
    // to test:builders (and be excluded from test:readers) or it will race.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      // lcov for the Codecov upload (codecov/codecov-action reads
      // coverage/lcov.info); json-summary/text for local + CI readouts.
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "src/**/*.mjs",
        "workers/**/*.mjs",
        "scripts/{artifact-budgets,lib,openapi-components,submission-notifications,submission-policy}.mjs",
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
