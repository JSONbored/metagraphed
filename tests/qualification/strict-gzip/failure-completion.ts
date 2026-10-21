// This composes already independently validated evidence; it never substitutes
// summary booleans for source, build, native lifecycle or test replay.
import assert from "node:assert/strict";
import { assertFailureReceipt } from "./failure-postgres-policy.ts";
const phases = [
  "uninstrumented",
  "instrumented",
  "unfixed-instrumented",
] as const;
const suites = {
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
export function assertFailureCompletion(baseline: any, evidence: any[]) {
  assert.equal(baseline.status, "passed");
  assert.equal(baseline.evidenceValidated, true);
  assert.equal(baseline.tests.passed, 490);
  assert.equal(baseline.tests.failed, 0);
  assert.equal(baseline.tests.skipped, 0);
  assert.deepEqual(
    baseline.tests.suites.map((row: any) => [row.path, row.passed]).sort(),
    Object.entries(suites).sort(),
  );
  assert.deepEqual(
    baseline.ownerTests.map((row: any) => [row.path, row.passed]).sort(),
    [
      ["tests/qualification/strict-gzip/queue-owner-resource.test.ts", 1],
      ["tests/qualification/strict-gzip/raw-owner-resource.test.ts", 1],
    ],
  );
  assert.ok(Array.isArray(evidence));
  assert.deepEqual(
    evidence.map((row) => row.phase),
    phases,
  );
  for (const row of evidence) {
    assert.equal(row.status, "passed");
    assert.equal(row.evidenceValidated, true);
    assert.equal(row.run.status, "passed");
    const proof = row.proof;
    assert.equal(proof.phase, row.phase);
    assert.equal(proof.sourceAndBundleValidated, true);
    assert.equal(proof.privateLifecycleRevalidated, true);
    assert.equal(proof.productionMemory, "inconclusive");
    assert.equal(proof.productionCpu, "inconclusive");
    assert.equal(proof.tests.phase, row.phase);
    assert.equal(proof.tests.suites, 1);
    assert.equal(
      proof.tests.passed,
      row.phase === "unfixed-instrumented" ? 1 : 3,
    );
    assert.equal(proof.tests.failed, 0);
    assert.equal(proof.tests.skipped, 0);
    assert.equal(
      proof.observedOwnerExits,
      row.phase === "unfixed-instrumented" ? 1 : 4,
    );
    assertFailureReceipt({ version: 1, phase: row.phase, cases: proof.cases });
  }
  return {
    baselineAssertions: 492,
    additionalFunctionalAssertions: 3,
    supplementalLifecycleAssertions: 3,
    genuineUnfixedControlAssertions: 1,
    totalAssertions: 499,
  };
}
