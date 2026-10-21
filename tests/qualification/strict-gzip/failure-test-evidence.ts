import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
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
  try {
    try {
      assert.ok(
        ["uninstrumented", "instrumented", "unfixed-instrumented"].includes(
          phase,
        ),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-001");
    }
    try {
      assert.ok(path.isAbsolute(root));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-002");
    }
    try {
      assert.ok(input && typeof input === "object" && !Array.isArray(input));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-003");
    }
    const titles =
      phase === "unfixed-instrumented"
        ? [FAILURE_CONTROL_TITLE]
        : FAILURE_REQUIRED_TITLES;
    try {
      assert.equal(input.success, true);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-004");
    }
    for (const key of [
      "numFailedTests",
      "numPendingTests",
      "numTodoTests",
      "numFailedTestSuites",
      "numPendingTestSuites",
    ])
      try {
        assert.equal(input[key] ?? 0, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fte-check-005");
      }
    try {
      assert.equal(input.numTotalTests, titles.length);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-006");
    }
    try {
      assert.equal(input.numPassedTests, titles.length);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-007");
    }
    try {
      assert.equal(input.numTotalTestSuites, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-008");
    }
    try {
      assert.equal(input.numPassedTestSuites, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-009");
    }
    try {
      assert.ok(Array.isArray(input.testResults));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-010");
    }
    try {
      assert.equal(input.testResults.length, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-011");
    }
    const suite = input.testResults[0];
    try {
      assert.equal(suite.name, path.join(root, FAILURE_TEST_FILE));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-012");
    }
    try {
      assert.equal(suite.status, "passed");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-013");
    }
    try {
      assert.ok(Array.isArray(suite.assertionResults));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-014");
    }
    try {
      assert.equal(suite.assertionResults.length, titles.length);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-015");
    }
    const seen = new Set<string>();
    for (const item of suite.assertionResults) {
      try {
        assert.equal(item.status, "passed");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fte-check-016");
      }
      try {
        assert.ok(titles.includes(item.title));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fte-check-017");
      }
      try {
        assert.ok(!seen.has(item.title));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fte-check-018");
      }
      seen.add(item.title);
      try {
        assert.ok(
          Array.isArray(item.failureMessages) &&
            item.failureMessages.length === 0,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fte-check-019");
      }
    }
    try {
      assert.deepEqual([...seen].sort(), [...titles].sort());
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fte-check-020");
    }
    return {
      phase,
      suites: 1,
      passed: titles.length,
      failed: 0,
      skipped: 0,
      requiredCases: titles.map((_, index) => ({
        index,
        status: "passed",
      })),
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fte-stage-001");
  }
}
