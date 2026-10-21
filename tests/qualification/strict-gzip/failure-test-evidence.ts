import assert from "node:assert/strict";
import path from "node:path";
export const FAILURE_TEST_FILE =
  "tests/qualification/strict-gzip/queue-owner-failure.test.ts";
export const FAILURE_REQUIRED_TITLES = Object.freeze([
  "the real queue rejects immutable wrong-password auth and independently ACKs the unchanged-valid control",
  "the real queue exposes cancelled second-family partial durability and byte-identical same-isolate manual recovery",
  "the real queue refuses the over-budget bad-tail input while good neighbors and same-isolate later work commit",
]);
export const FAILURE_CONTROL_TITLE =
  "the genuine unfixed queue auth control witnesses real rejection and specifically fails the client-end oracle";
export function validateFailureTestEvidence(
  input: any,
  root: string,
  phase: string,
) {
  assert.ok(
    ["uninstrumented", "instrumented", "unfixed-instrumented"].includes(phase),
  );
  assert.ok(path.isAbsolute(root));
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  const titles =
    phase === "unfixed-instrumented"
      ? [FAILURE_CONTROL_TITLE]
      : FAILURE_REQUIRED_TITLES;
  assert.equal(input.success, true);
  for (const key of [
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numFailedTestSuites",
    "numPendingTestSuites",
  ])
    assert.equal(input[key] ?? 0, 0);
  assert.equal(input.numTotalTests, titles.length);
  assert.equal(input.numPassedTests, titles.length);
  assert.equal(input.numTotalTestSuites, 1);
  assert.equal(input.numPassedTestSuites, 1);
  assert.ok(Array.isArray(input.testResults));
  assert.equal(input.testResults.length, 1);
  const suite = input.testResults[0];
  assert.equal(suite.name, path.join(root, FAILURE_TEST_FILE));
  assert.equal(suite.status, "passed");
  assert.ok(Array.isArray(suite.assertionResults));
  assert.equal(suite.assertionResults.length, titles.length);
  const seen = new Set<string>();
  for (const item of suite.assertionResults) {
    assert.equal(item.status, "passed");
    assert.ok(titles.includes(item.title));
    assert.ok(!seen.has(item.title));
    seen.add(item.title);
    assert.ok(
      Array.isArray(item.failureMessages) && item.failureMessages.length === 0,
    );
  }
  assert.deepEqual([...seen].sort(), [...titles].sort());
  return {
    phase,
    suites: 1,
    passed: titles.length,
    failed: 0,
    skipped: 0,
    requiredCases: titles.map((_, index) => ({ index, status: "passed" })),
  };
}
