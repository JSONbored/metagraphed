// Poller job outcomes reaching a queryable sink (metagraphed-infra#343 phase 1).
//
// THE INCIDENT THIS IS SIZED AGAINST. `hotkey_alpha` held zero rows for ~10
// hours. It failed 95 seconds into every run and slept 24 hours, and nothing
// reported it: the job only logs once it starts POSTing, so a failure before
// that is silent; `lane_health` held watchdog verdicts only; and every
// staleness watchdog keys on MAX(captured_at), which a never-successful lane
// does not have.
//
// So the assertions below are mostly about ABSENCE being detectable, which is
// the property that was missing rather than the one that was wrong.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  coercePollerJobOutcome,
  EXPECTED_POLLER_LANES,
  neverSucceededLanes,
  validPollerJobOutcome,
} from "../src/poller-lane-health.ts";

const OK = {
  lane: "hotkey-alpha",
  verdict: "ok",
  age_ms: 95_600,
  detail: null,
  checked_at: 1_785_960_000_000,
};

describe("validPollerJobOutcome", () => {
  test("accepts a well-formed outcome", () => {
    assert.equal(validPollerJobOutcome(OK), true);
    assert.equal(validPollerJobOutcome({ ...OK, verdict: "stale" }), true);
    assert.equal(validPollerJobOutcome({ ...OK, age_ms: null }), true);
  });

  test("accepts a lane nobody has listed yet", () => {
    // A NEW lane must be able to report on its first run. The newest lane is
    // the one most likely to be broken, so an allowlist here would silence
    // exactly the case this exists for -- which is what happened to
    // hotkey-alpha, absent from two of three wiring lists.
    assert.equal(validPollerJobOutcome({ ...OK, lane: "brand-new" }), true);
  });

  test("rejects shapes that would land as junk", () => {
    for (const bad of [
      null,
      "not an object",
      { ...OK, lane: "" },
      { ...OK, lane: "x".repeat(65) },
      { ...OK, verdict: "fine" },
      { ...OK, age_ms: -1 },
      { ...OK, age_ms: Number.NaN },
      { ...OK, detail: 42 },
      { ...OK, checked_at: 0 },
      { ...OK, checked_at: 1.5 },
      { ...OK, checked_at: "yesterday" },
    ]) {
      assert.equal(validPollerJobOutcome(bad), false, JSON.stringify(bad));
    }
  });
});

describe("coercePollerJobOutcome", () => {
  test("keeps the job's own message verbatim", () => {
    // This string is the whole point: it is the line that otherwise goes to a
    // container stderr nobody can read. The real one read "scan ended at 48779
    // entries, under the 76257 floor".
    const detail =
      "scan ended at 48779 entries, under the 76257 floor (0 decode error(s))";
    assert.equal(
      coercePollerJobOutcome({ ...OK, verdict: "stale", detail }).detail,
      detail,
    );
  });

  test("truncates a runaway detail rather than growing the table", () => {
    const row = coercePollerJobOutcome({ ...OK, detail: "x".repeat(10_000) });
    assert.equal(row.detail!.length, 2_000);
  });

  test("rounds a fractional elapsed, and preserves null", () => {
    assert.equal(coercePollerJobOutcome({ ...OK, age_ms: 95.6 }).age_ms, 96);
    assert.equal(coercePollerJobOutcome({ ...OK, age_ms: null }).age_ms, null);
  });
});

describe("neverSucceededLanes", () => {
  test("names a lane that has never once succeeded", () => {
    // THE REGRESSION. hotkey-alpha ran, failed, and left no successful tick for
    // ten hours. No staleness watchdog could see it, because there was no
    // captured_at to age -- absence was the signal and nothing was reading it.
    const succeeded = EXPECTED_POLLER_LANES.filter((l) => l !== "hotkey-alpha");
    assert.deepEqual(neverSucceededLanes(succeeded), ["hotkey-alpha"]);
  });

  test("is quiet when every expected lane has succeeded", () => {
    assert.deepEqual(neverSucceededLanes(EXPECTED_POLLER_LANES), []);
  });

  test("names ALL missing lanes, not just the first", () => {
    assert.deepEqual(neverSucceededLanes(["metagraph"]).length, 6);
  });

  test("an unexpected lane reporting does not mask a missing one", () => {
    // A lane nobody expected is not evidence about the ones we do expect.
    const succeeded = ["some-future-lane", ...EXPECTED_POLLER_LANES].filter(
      (l) => l !== "chain-detail",
    );
    assert.deepEqual(neverSucceededLanes(succeeded), ["chain-detail"]);
  });

  test("an empty success set names every expected lane", () => {
    // The cold-start shape, and the one that must not read as healthy: nothing
    // has reported, so everything is unproven.
    assert.deepEqual(
      neverSucceededLanes([]),
      [...EXPECTED_POLLER_LANES],
      "no reports means no lane is proven, not that all are fine",
    );
  });
});
