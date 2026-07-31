import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

// The CI coverage run, split into two vitest passes (#8922).
//
// WHY: every test file used to get its own module registry, so all 536 of them
// re-imported src/mcp-server.ts (~12.5k lines) and src/graphql.ts (~10k) from
// scratch. Measured on the full CI selection: 443s of user CPU, of which ~234s
// was module import. `isolate: false` reuses one registry per worker and cuts
// that to 148s -- a 66% reduction. CI runners are 4-core and compute-bound, so
// that lands almost directly on wall clock (unlike a core-rich laptop, where
// the run is already parallel-saturated and the change looks like nothing).
//
// WHY IT CAN'T JUST BE A CONFIG FLAG: a shared registry is fundamentally
// incompatible with per-file `vi.mock()`. Whichever file imports the real
// module first wins, and mocks leak across files -- observed as
// graphql-error-capture-and-error-code.test.ts failing deterministically and
// tao-usd-index-worker.test.ts failing only in the full run (pure ordering).
// So the mocking files keep their own registry and everything else shares one.
//
// The partition is COMPUTED, never hand-listed: a new test file that reaches
// for vi.mock is routed to the isolated pass automatically. A hand-maintained
// list would rot silently into exactly the cross-file contamination this is
// avoiding.
//
// NOT vitest `projects` (one invocation, auto-merged coverage), which looks
// like the natural fit: the artifact-writer pass needs fileParallelism false
// while these two need it true, which a single invocation cannot express, and
// excluding the writers via project globs would make
// `vitest run tests/artifacts.test` match nothing at all -- silently disabling
// them. They stay a separate invocation (test:ci:artifacts), unchanged.

/** Detects any API that manipulates the module registry for its own file. */
const MODULE_MOCKING = /\bvi\.(mock|doMock|unmock|resetModules)\s*\(/;

// The five filesystem-mutating files, run serially by test:ci:artifacts. Kept
// here so both passes exclude them from one definition -- see vitest.config.ts
// for why they cannot run alongside the readers.
const ARTIFACT_WRITERS = [
  "artifacts.test.ts",
  "discovery-artifacts.test.ts",
  "public-safety.test.ts",
  "validate-error-messages.test.ts",
  "refresh-build-summary.test.ts",
];

const testsDir = path.join(repoRoot, "tests");
const testFiles = readdirSync(testsDir).filter((name) =>
  name.endsWith(".test.ts"),
);
const mockingFiles = testFiles
  .filter((name) => !ARTIFACT_WRITERS.includes(name))
  .filter((name) =>
    MODULE_MOCKING.test(readFileSync(path.join(testsDir, name), "utf8")),
  )
  .sort();

if (mockingFiles.length === 0) {
  // Not a "nothing to do" case: the regex above silently matching nothing
  // would put module-mocking files into the shared pass and reintroduce the
  // contamination. Fail loudly instead.
  console.error(
    "run-ci-tests: found no module-mocking test files, which cannot be right " +
      "-- the detection regex is probably stale. Refusing to run a split that " +
      "would put mocking files in the shared-registry pass.",
  );
  process.exit(1);
}

// vitest's coverage thresholds are global-per-run, so NEITHER half can meet
// them: the shared pass alone measures 89.88% lines against the 92% floor,
// purely because the isolated pass's 17 files are missing from that
// denominator. Disabled per-pass rather than lowered, because a floor computed
// over an arbitrary subset is not a floor. Nothing is lost: vitest.config.ts
// documents these as "BACKSTOP floors only -- NOT the primary gate", the real
// CI gate is Codecov's delta-based project + patch over BOTH uploaded reports,
// and `npm run test:coverage` still runs the full suite unsplit with the
// thresholds enforced, which is the offline backstop they exist for.
const NO_PER_PASS_THRESHOLDS = [
  "--coverage.thresholds.lines=0",
  "--coverage.thresholds.statements=0",
  "--coverage.thresholds.functions=0",
  "--coverage.thresholds.branches=0",
];

const BASE = ["run", "--fileParallelism", "--testTimeout=30000"];
const excludeArgs = (names: string[]) =>
  names.flatMap((name) => ["--exclude", `**/${name}`]);

// CI sets VITEST_JUNIT_PATH for the test-results upload. Both passes would
// otherwise write the same file and the second would silently discard the
// first pass's 12k results -- give each its own and upload both.
function junitEnv(suffix: string): NodeJS.ProcessEnv {
  const configured = process.env.VITEST_JUNIT_PATH;
  if (!configured) return process.env;
  const parsed = path.parse(configured);
  return {
    ...process.env,
    VITEST_JUNIT_PATH: path.join(
      parsed.dir,
      `${parsed.name}${suffix}${parsed.ext}`,
    ),
  };
}

function runPass(label: string, args: string[], suffix: string): void {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync("npx", ["vitest", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env: junitEnv(suffix),
  });
  if (result.status !== 0) {
    console.error(`run-ci-tests: ${label} failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

// Pass 1 -- the bulk, one shared module registry per worker.
runPass(
  `shared registry (${testFiles.length - mockingFiles.length - ARTIFACT_WRITERS.length} files)`,
  [
    ...BASE,
    "--coverage",
    "--isolate=false",
    ...NO_PER_PASS_THRESHOLDS,
    ...excludeArgs([...ARTIFACT_WRITERS, ...mockingFiles]),
  ],
  "",
);

// Pass 2 -- the module-mocking files, each with its own registry. Coverage
// lands in its own directory so pass 1's report is not overwritten; CI uploads
// both to Codecov, which merges them.
runPass(
  `module-mocking, isolated (${mockingFiles.length} files)`,
  [
    ...BASE,
    "--coverage",
    "--coverage.reportsDirectory=coverage-mocked",
    ...NO_PER_PASS_THRESHOLDS,
    ...mockingFiles.map((name) => `tests/${name}`),
  ],
  "-mocked",
);

console.log(
  `\nrun-ci-tests: both passes green (${mockingFiles.length} isolated, ` +
    `${testFiles.length - mockingFiles.length - ARTIFACT_WRITERS.length} shared).`,
);
