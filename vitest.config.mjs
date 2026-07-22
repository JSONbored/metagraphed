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
    // Run test FILES sequentially (each still in its own isolated fork). Three
    // files mutate shared on-disk state outside their own process and must never
    // run alongside a concurrent reader/scanner of that same state:
    //   - tests/artifacts.test.mjs and tests/discovery-artifacts.test.mjs
    //     execFileSync the real scripts/build-artifacts.mjs, which mutates the
    //     shared on-disk artifact trees in place: it rm's + repopulates the R2
    //     staging dir (dist/metagraph-r2/metagraph, where R2-only artifacts such
    //     as registry-summary.json live with NO committed public/metagraph
    //     fallback) and writeFileSyncs forged JSON into committed
    //     public/metagraph files before restoring them. Reader tests that serve
    //     those artifacts via createLocalArtifactEnv (subnet-overview,
    //     mcp-server, api-coverage, …) would otherwise race that rebuild and
    //     intermittently 404 (e.g. GET /api/v1/registry/summary -> 404 instead
    //     of 200). The build output root resolves from the script's own
    //     location, so it can't be redirected to a temp dir without a full
    //     input+output tree copy.
    //   - tests/public-safety.test.mjs writes a transient fixture into
    //     dist/metagraph-r2/metagraph/fixtures/ (to exercise
    //     scan-public-safety.mjs's mirroredFixturePatterns exemption) and
    //     deletes it in afterEach. scripts/validate-schemas.mjs treats that same
    //     directory as a templated artifact location and schema-validates every
    //     .json file in it, so a concurrently-running consumer of
    //     validate-schemas.mjs (e.g. tests/validate-error-messages.test.mjs) can
    //     read the fixture mid-write or after cleanup and throw ENOENT.
    // Serializing these files is the clean, low-risk fix. Per-file fork
    // isolation is preserved; only filesystem-race concurrency is removed.
    //
    // This serial default keeps a plain `npm test` / `npm run test:coverage`
    // (which runs the FULL suite, including the three filesystem-mutating
    // writers) race-free. CI instead runs the suite in two non-overlapping
    // passes that recover the parallelism: `test:ci` runs everything EXCEPT the
    // three writers with `--fileParallelism` (the createLocalArtifactEnv readers
    // only READ, so they parallelize safely once no writer runs alongside them)
    // and a raised `--testTimeout` (the subprocess-spawning tests — public-safety's
    // full-repo scan, script-utils, r2-upload — are CPU-starved under parallel
    // load and would otherwise hit the 5s default); `test:ci:artifacts` then runs
    // the three writers serially. The passes are sequential, so writers never
    // overlap readers. Coverage is collected only in `test:ci` (all three
    // writers drive their assertions primarily via execFileSync child
    // processes — build-artifacts.mjs for the first two, scan-public-safety.mjs
    // for the third — contributing zero in-process coverage there; none of the
    // three scripts are in the `include` globs below, so moving their tests to
    // the serial pass has no coverage effect either way — verified Δ=0.00
    // across all metrics), keeping CI to a single Codecov upload.
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
      // .{mjs,ts} everywhere below: the TypeScript migration (metagraphed#7510)
      // converts these files to .ts in place over time, and a renamed file must
      // stay measured -- an .mjs-only glob would silently drop it from coverage
      // the moment it's renamed, rather than failing loud.
      include: [
        "src/**/*.{mjs,ts}",
        "workers/**/*.{mjs,ts}",
        "scripts/{artifact-budgets,lib,openapi-components,registry-identity}.{mjs,ts}",
        "scripts/lib/{build-readiness,economics-artifacts,endpoint-artifacts,enrichment-queue-artifacts,formatting,readme-links}.{mjs,ts}",
      ],
      // The workers/*.sentry.mjs deploy-entry wrappers (metagraphed#6479;
      // currently data-api.sentry.ts + registry-sync-api.sentry.ts --
      // workers/api.mjs's own Sentry wrapper hit that Worker's 1024 KiB
      // Cloudflare bundle ceiling, tracked separately, see #6479's own
      // follow-up) are deliberately coverage-invisible for the same reason
      // chain-firehose-relay.ts is: @sentry/cloudflare's withSentry()
      // requires real Cloudflare Workers runtime primitives
      // (AsyncLocalStorage-based context propagation via workerd) that
      // don't exist in this plain-Node vitest environment -- confirmed
      // empirically, importing one crashes with "Cannot read properties of
      // undefined (reading 'bind')" inside @sentry/cloudflare's own
      // flush-lock registry. Each wrapper is a thin, mechanical ~15-line
      // `Sentry.withSentry(fn, handler)` re-export; the REAL handler logic
      // it wraps (workers/data-api.mjs, workers/registry-sync-api.mjs) is
      // unaffected and stays fully covered as before -- these tests were
      // never routed through the wrapper.
      exclude: ["workers/*.sentry.{mjs,ts}"],
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
