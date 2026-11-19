import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateFailureTestEvidence,
  FAILURE_TEST_FILE,
  FAILURE_REQUIRED_TITLES,
  FAILURE_CONTROL_TITLE,
} from "./failure-test-evidence.ts";
const root = "/synthetic/failure-candidate";
function fixture(phase: string) {
  const titles =
    phase === "unfixed-instrumented"
      ? [FAILURE_CONTROL_TITLE]
      : FAILURE_REQUIRED_TITLES;
  return {
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
        name: root + "/" + FAILURE_TEST_FILE,
        status: "passed",
        assertionResults: titles.map((title) => ({
          title,
          status: "passed",
          failureMessages: [],
        })),
      },
    ],
  };
}
for (const phase of [
  "uninstrumented",
  "instrumented",
  "unfixed-instrumented",
]) {
  test(`accepts exact required phase tests ${phase}`, () =>
    assert.equal(
      validateFailureTestEvidence(fixture(phase), root, phase).passed,
      phase === "unfixed-instrumented" ? 1 : 3,
    ));
  const mutations: Record<string, (x: any) => void> = {
    missing: (x) => x.testResults[0].assertionResults.pop(),
    extra: (x) =>
      x.testResults[0].assertionResults.push({
        ...x.testResults[0].assertionResults[0],
      }),
    failed: (x) => (x.testResults[0].assertionResults[0].status = "failed"),
    skipped: (x) => (x.testResults[0].assertionResults[0].status = "pending"),
    title: (x) => (x.testResults[0].assertionResults[0].title = "unrecognized"),
    failure: (x) =>
      (x.testResults[0].assertionResults[0].failureMessages = ["secret-like"]),
    foreign: (x) => (x.testResults[0].name = "/foreign/" + FAILURE_TEST_FILE),
    totals: (x) => x.numTotalTests++,
    suite: (x) => x.numTotalTestSuites++,
    success: (x) => (x.success = false),
  };
  for (const [key, mutate] of Object.entries(mutations))
    test(`refuses ${key} evidence ${phase}`, () => {
      const x = fixture(phase);
      mutate(x);
      assert.throws(() => validateFailureTestEvidence(x, root, phase));
    });
}
test("negative control cannot replace the fixed phase", () =>
  assert.throws(() =>
    validateFailureTestEvidence(
      fixture("unfixed-instrumented"),
      root,
      "instrumented",
    ),
  ));
test("fixed phase cannot replace the genuine unfixed control", () =>
  assert.throws(() =>
    validateFailureTestEvidence(
      fixture("instrumented"),
      root,
      "unfixed-instrumented",
    ),
  ));
