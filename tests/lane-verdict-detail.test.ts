import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { laneVerdictDetail } from "../src/lane-verdict-detail.ts";

describe("laneVerdictDetail — the counts the verdict was decided on (#11384)", () => {
  test("A HEALTHY LANE PUBLISHES ITS COUNTS (#11390)", () => {
    // The change that unblocks deriving a coverage floor from history. These
    // counts used to be dropped the moment `reason` was absent, so they were
    // recorded ONLY while a lane was unhealthy -- measured 2026-08-18, 20 of
    // 658 `nominator-positions-staleness` verdicts carried them, and they
    // stopped the moment the lane recovered. A trailing median over that is a
    // median of bad passes.
    //
    // Bare, with no empty `()` in front: a healthy lane's detail reads as the
    // measurement it is.
    assert.equal(
      laneVerdictDetail(null, { covered: 19851, total: 19873, floor: 17010 }),
      "covered=19851, total=19873, floor=17010",
    );
    // And a reason still wins the prefix when there is one.
    assert.equal(
      laneVerdictDetail("partial", { covered: 16988, total: 19873 }),
      "partial (covered=16988, total=19873)",
    );
  });

  test("nothing to say is still null", () => {
    // The column's meaning for "no reason and nothing measurable" is unchanged,
    // so every lane with no coverage leg keeps writing null exactly as before.
    assert.equal(laneVerdictDetail(null, {}), null);
    assert.equal(laneVerdictDetail(null, { covered: undefined }), null);
    assert.equal(laneVerdictDetail(null, { covered: Number.NaN }), null);
  });

  test("a healthy lane has no detail", () => {
    // `ok` verdicts pass `reason: null`, and the column's existing meaning for
    // that is null rather than an empty string.
    assert.equal(laneVerdictDetail(null), null);
    assert.equal(laneVerdictDetail(undefined), null);
    assert.equal(laneVerdictDetail(""), null);
  });

  test("THE REAL CASE: partial carries covered, total and floor", () => {
    // Measured on production 2026-08-16. The published detail was the bare word
    // `partial`, and triage needed exactly these three numbers to tell a
    // 22-coldkey drift from a scan that died halfway.
    assert.equal(
      laneVerdictDetail("partial", {
        covered: 16_988,
        total: 19_873,
        floor: 17_010,
      }),
      "partial (covered=16988, total=19873, floor=17010)",
    );
  });

  test("no facts leaves the reason exactly as it was", () => {
    // The age-only lanes have no coverage leg, so they must round-trip
    // unchanged -- this is what makes converting them zero-risk.
    assert.equal(laneVerdictDetail("stale"), "stale");
    assert.equal(laneVerdictDetail("no_rows", {}), "no_rows");
  });

  test("UNMEASURABLE facts are dropped, never rendered as zero", () => {
    // "nothing covered" and "we could not count what was covered" are
    // different claims and only one is a fact.
    assert.equal(
      laneVerdictDetail("partial", {
        covered: null,
        total: undefined,
        floor: Number.NaN,
      }),
      "partial",
    );
    assert.equal(
      laneVerdictDetail("partial", { covered: Number.POSITIVE_INFINITY }),
      "partial",
    );
  });

  test("a measured zero SURVIVES, because zero is a fact", () => {
    assert.equal(
      laneVerdictDetail("partial", { covered: 0, floor: 17_010 }),
      "partial (covered=0, floor=17010)",
    );
  });

  test("partially-measurable facts keep the ones that read", () => {
    assert.equal(
      laneVerdictDetail("partial", { covered: 12, total: null, floor: 40 }),
      "partial (covered=12, floor=40)",
    );
  });

  test("a null facts object is tolerated", () => {
    assert.equal(
      laneVerdictDetail("stale", null as unknown as Record<string, number>),
      "stale",
    );
  });
});
