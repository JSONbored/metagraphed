// The test timeout belongs to the config, not to one npm script.
//
// This suite ran with two different budgets depending on how it was started:
// scripts/run-ci-tests.ts passed --testTimeout=30000, while `npm test`,
// `npm run test:coverage` and running a single file from an editor all got
// vitest's 5s default. Seven suites with no declared timeout sit at 2.1-3.0s
// under parallel load, so they cleared 5s only on an idle machine -- a full
// local run failed 13 tests across 12 files and then passed on a re-run, which
// reads as flakiness and is really a budget set too low everywhere except CI.
//
// Worse, the command the contributor guide tells you to run for the coverage
// gate (`npm run test:coverage`) was one of the short ones, so the local gate
// was flakier than the CI gate it is supposed to predict.
//
// These pin the fix in both directions: the config must carry the budget, and
// the CI runner must not go back to restating it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import config from "../vitest.config.ts";

const CI_RUNNER = "scripts/run-ci-tests.ts";

describe("test timeout is single-sourced in vitest.config.ts", () => {
  test("the config declares a timeout well above the 5s default", () => {
    const timeout = config.test?.testTimeout;
    assert.equal(
      typeof timeout,
      "number",
      "vitest.config.ts must declare testTimeout, or every runner but test:ci " +
        "falls back to vitest's 5s default",
    );
    // 30s is what CI already granted. The floor asserted here is the measured
    // worst case (~3.0s under load) with generous headroom, not the exact
    // number -- raising it later must not fail this.
    assert.ok(
      (timeout as number) >= 15_000,
      `testTimeout ${timeout}ms is below the measured danger band; the ` +
        "slowest undeclared tests reach ~3s under parallel load and spike well " +
        "past that under heavier contention",
    );
  });

  test("the CI runner does not restate the timeout", () => {
    // Two sources would let them drift apart again, which is the whole defect:
    // CI green on 30s while local ran on 5s and nobody could reproduce it.
    // Matched as a quoted ARGUMENT, not as any mention of the string -- the
    // file explains in prose why the flag is gone, and a test that could not
    // tell an argument from a comment about it would block that explanation.
    assert.doesNotMatch(
      readFileSync(CI_RUNNER, "utf8"),
      /["'`]--testTimeout/,
      `${CI_RUNNER} must inherit the timeout from vitest.config.ts rather ` +
        "than passing its own, or the two can disagree again",
    );
  });
});
