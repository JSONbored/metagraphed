import { defineConfig } from "vitest/config";

const junitPath = process.env.VITEST_JUNIT_PATH;

export default defineConfig({
  test: {
    environment: "node",
    // `.claude/**` keeps gitignored agent worktrees (.claude/worktrees/*, each a
    // full repo copy with its own tests) from doubling the run + skewing coverage.
    // `deploy/**` is standalone infra (the wss-lb service is tested via
    // `node --test`, not vitest) — keep it out of the Worker test run.
    // `apps/ui/**`, `packages/ui-kit/**`, and `packages/chain-summaries/**` each
    // have their own vitest config + test run, gated separately in CI.
    exclude: [
      "node_modules/**",
      "private/**",
      ".claude/**",
      "deploy/**",
      "apps/ui/**",
      "packages/ui-kit/**",
      "packages/chain-summaries/**",
    ],
    // Test files run in parallel. They used to be pinned sequential because
    // three of them mutated shared on-disk state outside their own process --
    // artifacts.test.ts rebuilt the artifact trees in place, public-safety.test
    // .ts planted a fixture that validate-schemas.ts also scanned, and
    // refresh-build-summary.test.ts rewrote build-summary.json at the R2
    // staging root -- which raced every createLocalArtifactEnv reader serving
    // those same trees (a rebuild mid-read shows up as GET
    // /api/v1/registry/summary -> 404).
    //
    // #8937 removed the cause rather than serializing around it: each of those
    // tests now clones the repo's data directories into a temp root and points
    // the real scripts at it via METAGRAPH_REPO_ROOT (see
    // tests/helpers/repo-sandbox.ts), so nothing mutates the shared tree and
    // there is no race left to avoid. That also deleted the separate serial CI
    // pass (`test:ci:artifacts`) those files needed.
    //
    // The raised timeout that used to live on test:ci now lives in this file
    // (see `testTimeout` below): the CPU-starved tests under parallel load are
    // not only the subprocess-spawning ones, and putting the number on a
    // single npm script left every other way of running the suite short.
    //
    // `test:ci` (scripts/run-ci-tests.ts) additionally splits by isolation
    // (#8922): the ~17 files that drive vi.mock/vi.doMock/vi.unmock/
    // vi.resetModules keep per-file isolation because they rewrite the module
    // registry itself, and every other file runs with `--isolate=false`,
    // sharing one registry per worker. Module *state* that used to leak across
    // those shared files is reset between files by setupFiles below; module
    // *identity* is what the split handles. Each pass emits its own lcov; CI
    // uploads both and Codecov merges them (codecov.yml pins after_n_builds so
    // the verdict waits for both).
    fileParallelism: true,
    // Restores module-level Worker state (in-isolate memos, breaker maps, the
    // configure* DI seams) after every test FILE, so a file's mutations cannot
    // leak into the next one when the module registry is shared. A no-op under
    // per-file isolation; required by `isolate: false`. See
    // src/module-state-registry.ts.
    setupFiles: ["tests/setup/reset-module-state.ts"],
    // Vitest's 5s default is too tight for THIS suite under file parallelism,
    // and the gap was papered over by putting the real number on one npm
    // script. Measured on a 12-core machine during a full parallel run that
    // passed, the slowest test in each of these sat at 2.1-3.0s with no
    // declared timeout of its own -- network-routing 2983ms,
    // subnet-idle-stake-handler 2639ms, network-addressing 2573ms,
    // request-handlers-entities 2503ms, r2-upload 2312ms, zod-schemas 2301ms,
    // subnet-hyperparams-history-csv 2098ms -- so they cleared 5s only while
    // the machine was not busy. Under heavier contention the same run failed
    // 13 tests across 12 files, and re-running it green is what made this look
    // like flakiness rather than a budget set too low.
    //
    // 30s is not new: scripts/run-ci-tests.ts has passed --testTimeout=30000
    // since this class of failure first appeared, so CI has always had it.
    // What it did NOT cover is `npm test`, `npm run test:coverage`, or running
    // one file from an editor -- all plain `vitest run`. The coverage command
    // the contributor guide tells you to run locally was the flaky one while
    // CI was green, which is the wrong way round.
    //
    // Declaring it here makes every invocation agree, and lets
    // run-ci-tests.ts stop restating it. Files needing MORE than this still
    // say so themselves (tests/public-safety.test.ts's 45s full-repo scan).
    testTimeout: 30_000,
    // Takes ONE pristine copy of the tree before any worker starts, which every
    // per-file sandbox then clones from. Cloning the LIVE repo instead is racy
    // by construction: lib.ts writes JSON atomically, so a concurrent writer
    // leaves temp files that vanish mid-copy. See
    // tests/setup/artifact-snapshot.ts.
    globalSetup: ["tests/setup/artifact-snapshot.ts"],
    // vi.stubGlobal/vi.stubEnv are restored automatically rather than relying on
    // 54 hand-written restores across 11 files — the same cross-file hygiene the
    // reset registry gives module state.
    unstubGlobals: true,
    unstubEnvs: true,
    reporters: junitPath ? ["default", "junit"] : ["default"],
    ...(junitPath ? { outputFile: { junit: junitPath } } : {}),
    coverage: {
      provider: "v8",
      // lcov for the Codecov upload (codecov/codecov-action reads
      // coverage/lcov.info); json-summary/text for local + CI readouts.
      reporter: ["text", "json-summary", "lcov"],
      // Only the in-process scripts are listed. The heavily-exercised build
      // scripts (scripts/build-artifacts.ts and its siblings) are intentionally
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
        // types-epic A (metagraphed#7859): schema definitions only (no
        // runtime import from any Worker entry yet, by that issue's own
        // scope), exercised in-process by tests/zod-schemas.test.ts.
        "schemas-src/**/*.ts",
      ],
      // workers/api.entry.ts (metagraphed#7766, replacing the old
      // workers/api.sentry.ts wrapper) can't even be IMPORTED in this
      // plain-Node vitest environment, let alone covered -- confirmed
      // empirically: `import("./workers/api.entry.ts")` throws "Only URLs
      // with a scheme in: file, data, and node are supported by the default
      // ESM loader. Received protocol 'cloudflare:'", because
      // @cloudflare/workers-oauth-provider's own runtime file imports
      // `cloudflare:workers` at module scope (same root cause
      // src/github-oauth.ts's defaultGetOAuthHelpers documents for the
      // lazy-import it needs for the same reason). The real logic this file
      // wires together (isAnonymousMcpRequest, buildOAuthProviderOptions)
      // is fully covered directly in tests/github-oauth.test.ts; this file
      // itself is a thin, mechanical composition layer with nothing of its
      // own worth testing.
      exclude: ["workers/api.entry.ts"],
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
