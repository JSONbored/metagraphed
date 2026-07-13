import { defineConfig } from "vitest/config";

const junitPath = process.env.VITEST_JUNIT_PATH;

export default defineConfig({
  test: {
    environment: "node",
    // `.claude/**` keeps gitignored agent worktrees (.claude/worktrees/*, each a
    // full repo copy with its own tests) from doubling the run + skewing coverage.
    // `deploy/**` is standalone infra (the wss-lb service is tested via
    // `node --test`, not vitest) — keep it out of the Worker test run.
    // `apps/ui/**` and `packages/ui-kit/**` each have their own vitest config +
    // test run, gated separately in CI.
    exclude: [
      "node_modules/**",
      "private/**",
      ".claude/**",
      "deploy/**",
      "apps/ui/**",
      "packages/ui-kit/**",
    ],
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
    // This serial default keeps a plain `npm test` / `npm run test:coverage`
    // (which runs the FULL suite, including the two filesystem-mutating writers)
    // race-free. CI instead runs the suite in two non-overlapping passes that
    // recover the parallelism: `test:ci` runs everything EXCEPT the two writers
    // with `--fileParallelism` (the 27 createLocalArtifactEnv readers only READ,
    // so they parallelize safely once no writer runs alongside them) and a raised
    // `--testTimeout` (the subprocess-spawning tests — public-safety's full-repo
    // scan, script-utils, r2-upload — are CPU-starved under parallel load and
    // would otherwise hit the 5s default); `test:ci:artifacts` then runs the two
    // writers serially. The passes are sequential, so writers never overlap
    // readers. Coverage is collected only in `test:ci` (the writers drive their
    // work via execFileSync child processes, contributing zero in-process
    // coverage — verified Δ=0.00 across all metrics), keeping CI to a single
    // Codecov upload.
    fileParallelism: false,
    reporters: junitPath ? ["default", "junit"] : ["default"],
    ...(junitPath ? { outputFile: { junit: junitPath } } : {}),
    coverage: {
      provider: "v8",
      // lcov for the Codecov upload (codecov/codecov-action reads
      // coverage/lcov.info); json-summary/text for local + CI readouts.
      reporter: ["text", "json-summary", "lcov"],
      // Only the in-process scripts are listed. The heavily-exercised build
      // scripts (scripts/build-artifacts.mjs and its siblings) are intentionally
      // coverage-invisible: the artifact-build tests run them via execFileSync as
      // a child process, so the in-process V8 collector never sees those lines.
      // Adding them to `include` would report a misleading ~0% and risk tripping
      // the floors below. If their coverage is ever wanted, add targeted unit
      // tests of their pure helpers (imported in-process) rather than the
      // execFileSync entrypoint.
      //
      // The `scripts/lib/` modules below are the PURE helpers already extracted
      // out of those build scripts. They are exercised in-process (imported by
      // their own dedicated tests/<module>.test.mjs unit suites), so they are
      // listed file-by-file here rather than via `scripts/lib/**/*.mjs`: a future
      // module dropped into that directory without a dedicated test would
      // otherwise be auto-measured and trip the floors below.
      include: [
        "src/**/*.mjs",
        "workers/**/*.mjs",
        "scripts/{artifact-budgets,lib,openapi-components,registry-identity}.mjs",
        "scripts/lib/{build-readiness,economics-artifacts,endpoint-artifacts,enrichment-queue-artifacts,formatting,readme-links}.mjs",
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
