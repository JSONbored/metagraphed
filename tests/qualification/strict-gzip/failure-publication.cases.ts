// Synthetic composition checks only. A successful fixture is not a native run:
// production publication must first replay the baseline and each private proof.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { assertFailureCompletion } from "./failure-completion.ts";
import { publishFailureQualification } from "./failure-public-receipts.ts";
import { FAILURE_PHASES, type FailurePhase } from "./failure-variants.ts";
import {
  FAILURE_CONTROL_TITLE,
  FAILURE_REQUIRED_TITLES,
  FAILURE_TEST_FILE,
  validateFailureTestEvidence,
} from "./failure-test-evidence.ts";
import {
  assertFailureReceipt,
  FAILURE_HYPERDRIVES,
} from "./failure-postgres-policy.ts";
import {
  OWNER_TESTS,
  OWNER_TITLES,
  splitOwnerTests,
} from "./owner-test-evidence.ts";
import { REQUIRED_ASSERTIONS, validateTestEvidence } from "./receipt-policy.ts";
import { FOCUSED_TESTS } from "./verify-candidate.ts";
import {
  QUEUE_EXTERNAL_SERVICE,
  QUEUE_HYPERDRIVES,
  sha256,
} from "./postgres-owner-fixture.ts";

const candidate = "/synthetic/failure-reference";
const baselineCounts: Record<string, number> = {
  "tests/data-api-sync-quarantine-isolate.test.ts": 7,
  "tests/data-api-sync-queue-consumer.test.ts": 23,
  "tests/strict-gzip-host-guard.test.ts": 18,
  "tests/strict-gzip-reader-coordinator.test.ts": 5,
  "tests/strict-gzip-reader-isolate.test.ts": 200,
  "tests/strict-gzip-reader.test.ts": 188,
  "tests/sync-batch-compress.test.ts": 9,
  "tests/sync-batch-decoded-limits.test.ts": 9,
  "tests/sync-batch-strict-reader.test.ts": 5,
  "tests/sync-dead-letter-store.test.ts": 26,
};

function baselineFixture() {
  const testResults = FOCUSED_TESTS.map((file) => {
    const required = REQUIRED_ASSERTIONS[file] ?? [];
    return {
      name: path.join(candidate, file),
      status: "passed",
      assertionResults: Array.from(
        { length: baselineCounts[file]! },
        (_, index) => ({
          title: required[index] ?? `synthetic baseline assertion ${index}`,
          status: "passed",
          failureMessages: [],
        }),
      ),
    };
  });
  testResults.push(
    ...OWNER_TESTS.map((file, index) => ({
      name: path.join(candidate, file),
      status: "passed",
      assertionResults: [
        { title: OWNER_TITLES[index]!, status: "passed", failureMessages: [] },
      ],
    })),
  );
  const split = splitOwnerTests(
    {
      success: true,
      numTotalTests: 492,
      numPassedTests: 492,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 0,
      testResults,
    },
    candidate,
  );
  return {
    status: "passed",
    evidenceValidated: true,
    tests: validateTestEvidence(split.focused, candidate),
    ownerTests: split.owners,
  };
}

function testEvidence(phase: FailurePhase) {
  const titles =
    phase === "unfixed-instrumented"
      ? [FAILURE_CONTROL_TITLE]
      : FAILURE_REQUIRED_TITLES;
  return validateFailureTestEvidence(
    {
      success: true,
      numTotalTests: titles.length,
      numPassedTests: titles.length,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      testResults: [
        {
          name: path.join(candidate, FAILURE_TEST_FILE),
          status: "passed",
          assertionResults: titles.map((title) => ({
            title,
            status: "passed",
            failureMessages: [],
          })),
        },
      ],
    },
    candidate,
    phase,
  );
}

function casesFixture(phase: FailurePhase) {
  const negative = phase === "unfixed-instrumented";
  const plans = negative
    ? [
        {
          scenario: "auth-unfixed-control",
          bodies: 1,
          partial: [0, 0, 0, 0],
          final: [0, 0, 0, 0],
          runtimes: 1,
          replay: "no-replay",
          dispositions: [{ ack: [], retry: ["failure-auth-unfixed"] }],
        },
      ]
    : [
        {
          scenario: "auth-rejection",
          bodies: 2,
          partial: [0, 0, 0, 0],
          final: [1, 1, 1, 1],
          runtimes: 2,
          replay: "separate-valid-runtime",
          dispositions: [
            { ack: [], retry: ["failure-auth"] },
            { ack: ["control-auth"], retry: [] },
          ],
        },
        {
          scenario: "query-cancellation",
          bodies: 2,
          partial: [1, 2, 1, 2],
          final: [2, 2, 2, 2],
          runtimes: 1,
          replay: "byte-identical-same-isolate",
          dispositions: [
            { ack: ["neighbor-query"], retry: ["failure-query"] },
            { ack: ["failure-query"], retry: [] },
          ],
        },
        {
          scenario: "decoder-refusal",
          bodies: 4,
          partial: [2, 2, 2, 2],
          final: [3, 3, 3, 3],
          runtimes: 1,
          replay: "same-isolate-subsequent-success",
          dispositions: [
            {
              ack: ["neighbor-before", "neighbor-after"],
              retry: ["failure-decoder"],
            },
            { ack: ["neighbor-later"], retry: [] },
          ],
        },
      ];
  const cases = plans.map((plan, caseIndex) => ({
    scenario: plan.scenario,
    phase,
    modules: [{ sha256: sha256("synthetic module bytes"), bytes: 22 }],
    lifecycle: negative
      ? "negative-control-passed"
      : phase === "instrumented"
        ? "supplemental-passed"
        : "not-instrumented",
    productionMemory: "inconclusive",
    productionCpu: "inconclusive",
    bodySha256: Array.from({ length: plan.bodies }, (_, index) =>
      sha256(`${phase}:${plan.scenario}:body:${index}`),
    ),
    dispositions: plan.dispositions,
    partialCounts: plan.partial,
    finalCounts: plan.final,
    partialSha256: sha256(`${phase}:${plan.scenario}:partial`),
    finalSha256: sha256(`${phase}:${plan.scenario}:final`),
    runtimes: Array.from({ length: plan.runtimes }, (_, runtimeIndex) => ({
      mappingSha256: sha256(
        JSON.stringify(
          caseIndex === 0 && runtimeIndex === 0
            ? FAILURE_HYPERDRIVES
            : QUEUE_HYPERDRIVES,
        ),
      ),
      serviceSha256: sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
      isolateSha256: sha256(`${phase}:${caseIndex}:${runtimeIndex}`),
      runtimeSha256: sha256("synthetic pinned runtime"),
      guardedNativeLaunches: 1,
      observedNativeExits: 1,
      restarts: 0,
      blockedOutbound: 0,
      pending: 0,
      remainingWriterSessions: 0,
      stableZeroSamples: 2,
    })),
    replay: plan.replay,
    ...(negative
      ? {
          negativeControl: {
            clients: 3,
            rejectedConnects: 3,
            observedEndCalls: 0,
            fixedLifecycleOracle: "rejected-missing-end",
          },
        }
      : {}),
  }));
  const receipt: unknown = { version: 1, phase, cases };
  assertFailureReceipt(receipt);
  return receipt.cases;
}

function completionFixture(): { baseline: any; phases: any[] } {
  return {
    baseline: baselineFixture(),
    phases: FAILURE_PHASES.map((phase) => ({
      phase,
      status: "passed",
      evidenceValidated: true,
      run: { status: "passed" },
      proof: {
        phase,
        tests: testEvidence(phase),
        cases: casesFixture(phase),
        sourceAndBundleValidated: true,
        privateLifecycleRevalidated: true,
        observedOwnerExits: phase === "unfixed-instrumented" ? 1 : 4,
        productionMemory: "inconclusive",
        productionCpu: "inconclusive",
      },
    })),
  };
}

test("completion preserves exact 492 baseline plus 3 functional, 3 supplemental and 1 genuine control assertions", () => {
  const { baseline, phases } = completionFixture();
  const before = structuredClone({ baseline, phases });
  assert.deepEqual(assertFailureCompletion(baseline, phases), {
    baselineAssertions: 492,
    additionalFunctionalAssertions: 3,
    supplementalLifecycleAssertions: 3,
    genuineUnfixedControlAssertions: 1,
    totalAssertions: 499,
  });
  assert.deepEqual({ baseline, phases }, before);
  assert.deepEqual(
    phases.map((row) => row.proof.observedOwnerExits),
    [4, 4, 1],
  );
  assert.equal(phases[2].proof.cases[0].negativeControl.clients, 3);
});

for (const [name, mutate] of Object.entries({
  "baseline boolean": (f: any) => {
    f.baseline = true;
  },
  "baseline success booleans without tests": (f: any) => {
    f.baseline = { status: "passed", evidenceValidated: true };
  },
  "failed baseline": (f: any) => {
    f.baseline.status = "failed";
  },
  "unvalidated baseline": (f: any) => {
    f.baseline.evidenceValidated = false;
  },
  "replacement focused count": (f: any) => {
    f.baseline.tests.passed = 499;
  },
  "failed baseline assertion": (f: any) => {
    f.baseline.tests.failed = 1;
  },
  "skipped baseline assertion": (f: any) => {
    f.baseline.tests.skipped = 1;
  },
  "missing baseline suite": (f: any) => {
    f.baseline.tests.suites.pop();
  },
  "duplicate baseline suite": (f: any) => {
    f.baseline.tests.suites[1] = f.baseline.tests.suites[0];
  },
  "redistributed unchanged total": (f: any) => {
    f.baseline.tests.suites[0].passed++;
    f.baseline.tests.suites[1].passed--;
  },
  "renamed baseline suite": (f: any) => {
    f.baseline.tests.suites[0].path = FAILURE_TEST_FILE;
  },
  "baseline owner booleans": (f: any) => {
    f.baseline.ownerTests = [true, true];
  },
  "missing baseline owner": (f: any) => {
    f.baseline.ownerTests.pop();
  },
  "duplicate baseline owner": (f: any) => {
    f.baseline.ownerTests[1] = f.baseline.ownerTests[0];
  },
  "supplemental owner replaces original": (f: any) => {
    f.baseline.ownerTests[0].path = FAILURE_TEST_FILE;
  },
  "extra assertion in baseline owner": (f: any) => {
    f.baseline.ownerTests[0].passed = 2;
  },
  "boolean phases": (f: any) => {
    f.phases = [true, true, true];
  },
  "missing uninstrumented phase": (f: any) => {
    f.phases.shift();
  },
  "missing supplemental phase": (f: any) => {
    f.phases.splice(1, 1);
  },
  "missing genuine unfixed phase": (f: any) => {
    f.phases.pop();
  },
  "duplicate fixed phase": (f: any) => {
    f.phases[1] = structuredClone(f.phases[0]);
  },
  "reordered phases": (f: any) => {
    f.phases.reverse();
  },
  "extra repeated phase": (f: any) => {
    f.phases.push(structuredClone(f.phases[2]));
  },
  "control replaced by passed boolean": (f: any) => {
    f.phases[2] = {
      phase: "unfixed-instrumented",
      status: "passed",
      evidenceValidated: true,
      run: { status: "passed" },
      proof: true,
    };
  },
}))
  test(`completion refuses ${name}`, () => {
    const fixture = completionFixture();
    mutate(fixture);
    assert.throws(() =>
      assertFailureCompletion(fixture.baseline, fixture.phases),
    );
  });

for (const phase of FAILURE_PHASES)
  for (const [name, mutate] of Object.entries({
    "failed phase": (row: any) => {
      row.status = "failed";
    },
    "failed runner": (row: any) => {
      row.run.status = "failed";
    },
    "unvalidated evidence": (row: any) => {
      row.evidenceValidated = false;
    },
    "boolean proof": (row: any) => {
      row.proof = true;
    },
    "wrong proof phase": (row: any) => {
      row.proof.phase = "different";
    },
    "missing source replay": (row: any) => {
      row.proof.sourceAndBundleValidated = false;
    },
    "missing private replay": (row: any) => {
      row.proof.privateLifecycleRevalidated = false;
    },
    "boolean tests": (row: any) => {
      row.proof.tests = true;
    },
    "wrong test phase": (row: any) => {
      row.proof.tests.phase = "different";
    },
    "extra test suite": (row: any) => {
      row.proof.tests.suites = 2;
    },
    "missing assertion": (row: any) => {
      row.proof.tests.passed--;
    },
    "extra assertion": (row: any) => {
      row.proof.tests.passed++;
    },
    "failed assertion": (row: any) => {
      row.proof.tests.failed = 1;
    },
    "skipped assertion": (row: any) => {
      row.proof.tests.skipped = 1;
    },
    "missing observed owner exit": (row: any) => {
      row.proof.observedOwnerExits--;
    },
    "extra observed owner exit": (row: any) => {
      row.proof.observedOwnerExits++;
    },
    "boolean cases": (row: any) => {
      row.proof.cases = true;
    },
    "missing case": (row: any) => {
      row.proof.cases.pop();
    },
    "extra case": (row: any) => {
      row.proof.cases.push(structuredClone(row.proof.cases[0]));
    },
    "claimed production memory": (row: any) => {
      row.proof.productionMemory = "passed";
    },
    "claimed production CPU": (row: any) => {
      row.proof.productionCpu = "passed";
    },
  }))
    test(`completion refuses ${name} in ${phase}`, () => {
      const fixture = completionFixture();
      mutate(fixture.phases.find((row) => row.phase === phase));
      assert.throws(() =>
        assertFailureCompletion(fixture.baseline, fixture.phases),
      );
    });

for (const [name, mutate] of Object.entries({
  "true instead of per-client evidence": (control: any) => {
    control.negativeControl = true;
  },
  "zero constructed clients": (control: any) => {
    control.negativeControl.clients = 0;
    control.negativeControl.rejectedConnects = 0;
  },
  "message count instead of client rejection count": (control: any) => {
    control.negativeControl.rejectedConnects = 1;
  },
  "end call observed in unfixed control": (control: any) => {
    control.negativeControl.observedEndCalls = 1;
  },
  "oracle success instead of specific missing end rejection": (
    control: any,
  ) => {
    control.negativeControl.fixedLifecycleOracle = "passed";
  },
  "generic lifecycle failure": (control: any) => {
    control.negativeControl.fixedLifecycleOracle = "rejected";
  },
  "supplemental lifecycle label": (control: any) => {
    control.lifecycle = "supplemental-passed";
  },
  "ACK on rejected original": (control: any) => {
    control.dispositions[0].ack = ["failure-auth-unfixed"];
  },
  "duplicate retry": (control: any) => {
    control.dispositions[0].retry.push("failure-auth-unfixed");
  },
  "business row appeared": (control: any) => {
    control.finalCounts[0] = 1;
  },
  "no observed native exit": (control: any) => {
    control.runtimes[0].observedNativeExits = 0;
  },
  "hidden restart": (control: any) => {
    control.runtimes[0].restarts = 1;
  },
  "unfinished operation": (control: any) => {
    control.runtimes[0].pending = 1;
  },
}))
  test(`genuine negative control composition refuses ${name}`, () => {
    const fixture = completionFixture();
    mutate(fixture.phases[2].proof.cases[0]);
    assert.throws(() =>
      assertFailureCompletion(fixture.baseline, fixture.phases),
    );
  });

function publicationPaths(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "failure-publication-pure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = {
    root,
    raw: path.join(root, "raw"),
    output: path.join(root, "output"),
    reference: path.join(root, "reference"),
    base: path.join(root, "base"),
    variants: path.join(root, "variants"),
  };
  for (const directory of [
    paths.raw,
    paths.reference,
    paths.base,
    paths.variants,
  ])
    mkdirSync(directory);
  return paths;
}
function publish(paths: ReturnType<typeof publicationPaths>) {
  return publishFailureQualification(
    paths.raw,
    paths.output,
    paths.reference,
    paths.base,
    paths.variants,
  );
}

for (const input of ["raw", "reference", "base", "variants"] as const)
  test(`publisher refuses output nested under ${input} before any proof execution`, async (t) => {
    const paths = publicationPaths(t);
    paths.output = path.join(paths[input], "output");
    await assert.rejects(() => publish(paths));
    assert.equal(existsSync(paths.output), false);
  });

test("publisher refuses nonfresh output and preserves existing bytes", async (t) => {
  const paths = publicationPaths(t);
  mkdirSync(paths.output);
  writeFileSync(path.join(paths.output, "sentinel"), "unchanged");
  await assert.rejects(() => publish(paths));
  assert.equal(
    readFileSync(path.join(paths.output, "sentinel"), "utf8"),
    "unchanged",
  );
});

for (const kind of [
  "unexpected-directory",
  "raw-file",
  "phase-symlink",
  "raw-symlink",
])
  test(`publisher refuses ${kind} without publishing raw bytes`, async (t) => {
    const paths = publicationPaths(t);
    if (kind === "unexpected-directory")
      mkdirSync(path.join(paths.raw, "unreviewed-phase"));
    if (kind === "raw-file")
      writeFileSync(path.join(paths.raw, "receipt.json"), "private sentinel");
    if (kind === "phase-symlink")
      symlinkSync(paths.base, path.join(paths.raw, "baseline"), "dir");
    if (kind === "raw-symlink") {
      rmSync(paths.raw, { recursive: true });
      symlinkSync(paths.base, paths.raw, "dir");
    }
    await assert.rejects(() => publish(paths));
    assert.equal(existsSync(paths.output), false);
  });

test("publisher refuses a baseline pass made only of booleans", async (t) => {
  const paths = publicationPaths(t),
    run = path.join(paths.raw, "baseline", "native-synthetic");
  mkdirSync(run, { recursive: true });
  writeFileSync(
    path.join(run, "receipt.json"),
    JSON.stringify({
      status: "passed",
      evidenceValidated: true,
      ownerEvidence: true,
      baselinePassed: true,
      negativeControlPassed: true,
    }),
  );
  await assert.rejects(() => publish(paths));
  assert.equal(existsSync(paths.output), false);
});
