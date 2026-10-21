import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
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
  try {
    try {
      assert.equal(baseline.status, "passed");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-001");
    }
    try {
      assert.equal(baseline.evidenceValidated, true);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-002");
    }
    try {
      assert.equal(baseline.tests.passed, 490);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-003");
    }
    try {
      assert.equal(baseline.tests.failed, 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-004");
    }
    try {
      assert.equal(baseline.tests.skipped, 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-005");
    }
    try {
      assert.deepEqual(
        baseline.tests.suites.map((row: any) => [row.path, row.passed]).sort(),
        Object.entries(suites).sort(),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-006");
    }
    try {
      assert.deepEqual(
        baseline.ownerTests.map((row: any) => [row.path, row.passed]).sort(),
        [
          ["tests/qualification/strict-gzip/queue-owner-resource.test.ts", 1],
          ["tests/qualification/strict-gzip/raw-owner-resource.test.ts", 1],
        ],
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-007");
    }
    try {
      assert.ok(Array.isArray(evidence));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-008");
    }
    try {
      assert.deepEqual(
        evidence.map((row) => row.phase),
        phases,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fco-check-009");
    }
    for (const row of evidence) {
      try {
        assert.equal(row.status, "passed");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-010");
      }
      try {
        assert.equal(row.evidenceValidated, true);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-011");
      }
      try {
        assert.equal(row.run.status, "passed");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-012");
      }
      const proof = row.proof;
      try {
        assert.equal(proof.phase, row.phase);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-013");
      }
      try {
        assert.equal(proof.sourceAndBundleValidated, true);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-014");
      }
      try {
        assert.equal(proof.privateLifecycleRevalidated, true);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-015");
      }
      try {
        assert.equal(proof.productionMemory, "inconclusive");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-016");
      }
      try {
        assert.equal(proof.productionCpu, "inconclusive");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-017");
      }
      try {
        assert.equal(proof.tests.phase, row.phase);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-018");
      }
      try {
        assert.equal(proof.tests.suites, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-019");
      }
      try {
        assert.equal(
          proof.tests.passed,
          row.phase === "unfixed-instrumented" ? 1 : 3,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-020");
      }
      try {
        assert.equal(proof.tests.failed, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-021");
      }
      try {
        assert.equal(proof.tests.skipped, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-022");
      }
      try {
        assert.equal(
          proof.observedOwnerExits,
          row.phase === "unfixed-instrumented" ? 1 : 4,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-023");
      }
      try {
        assertFailureReceipt({
          version: 1,
          phase: row.phase,
          cases: proof.cases,
        });
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fco-check-024");
      }
    }
    return {
      baselineAssertions: 492,
      additionalFunctionalAssertions: 3,
      supplementalLifecycleAssertions: 3,
      genuineUnfixedControlAssertions: 1,
      totalAssertions: 499,
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fco-stage-001");
  }
}
