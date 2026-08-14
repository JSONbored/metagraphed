// #11146 phases 1-2: the capture lane's freshness, and what drift_status is
// honestly measured against.
//
// The bug this pins was live for 11 days: `drift_status: "unchanged"` compares
// our snapshot to our PREVIOUS snapshot, and with the capture lane manual-only
// that was trivially true while upstream moved -- 23 of 24 measurably-drifted
// subnets reported `unchanged`. A contract agreeing with itself proves
// nothing. The fix is not a fetch; it is saying so in the payload.
//
// The load-bearing case is the CLOCK. `buildTimestamp()` returns the 1970
// epoch placeholder in every local and determinism build, so a naive
// `Math.max(0, now - captured)` publishes a 12-day-old capture as ZERO HOURS
// OLD -- the same dishonesty, reintroduced. Unknown must stay null.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  captureFreshness,
  SCHEMA_CAPTURE_CADENCE_HOURS,
} from "../src/schema-snapshots-sync.ts";

/** The REAL rule the artifact builder stamps with -- imported, never
 * re-implemented: a test that restates the logic it checks would agree with a
 * broken rule as happily as a correct one. */
const stamp = captureFreshness;

describe("the cadence", () => {
  test("is a positive number of hours, declared once", () => {
    assert.equal(Number.isFinite(SCHEMA_CAPTURE_CADENCE_HOURS), true);
    assert.equal(SCHEMA_CAPTURE_CADENCE_HOURS > 0, true);
  });
});

describe("capture age", () => {
  test("a capture inside the cadence is fresh", () => {
    const row = stamp("2026-08-14T12:00:00.000Z", "2026-08-13T12:00:00.000Z");
    assert.equal(row.capture_age_hours, 24);
    assert.equal(row.capture_stale, false);
  });

  test("a capture past the cadence is STALE, not 'unchanged'", () => {
    // The production shape on 2026-08-14: captures from 2026-08-02.
    const row = stamp("2026-08-14T12:00:00.000Z", "2026-08-02T07:31:05.148Z");
    assert.equal((row.capture_age_hours as number) > 280, true);
    assert.equal(row.capture_stale, true);
  });

  test("exactly at the cadence is not yet stale (strictly greater)", () => {
    const captured = new Date(
      Date.parse("2026-08-14T12:00:00.000Z") -
        SCHEMA_CAPTURE_CADENCE_HOURS * 3_600_000,
    ).toISOString();
    const row = stamp("2026-08-14T12:00:00.000Z", captured);
    assert.equal(row.capture_age_hours, SCHEMA_CAPTURE_CADENCE_HOURS);
    assert.equal(row.capture_stale, false);
  });
});

describe("an unusable clock is UNKNOWN, never fresh", () => {
  test("the 1970 build placeholder yields null, not zero hours", () => {
    // The regression that reached a built artifact during development: with
    // Math.max(0, ...) this row published capture_stale:false for a capture
    // twelve days old.
    const row = stamp("1970-01-01T00:00:00.000Z", "2026-08-02T07:31:05.148Z");
    assert.equal(row.capture_age_hours, null);
    assert.equal(row.capture_stale, null);
  });

  test("a missing or unparseable capture timestamp yields null", () => {
    for (const bad of [null, "", "not-a-date"]) {
      const row = stamp("2026-08-14T12:00:00.000Z", bad);
      assert.equal(row.capture_age_hours, null, String(bad));
      assert.equal(row.capture_stale, null, String(bad));
    }
  });
});

describe("drift_basis names what the comparison is against", () => {
  test("every stamped entry declares the basis, whatever the clock said", () => {
    for (const build of [
      "1970-01-01T00:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
    ])
      assert.equal(
        stamp(build, "2026-08-02T07:31:05.148Z").drift_basis,
        "previous-capture",
        "drift_status must never be readable as an upstream comparison",
      );
  });
});
