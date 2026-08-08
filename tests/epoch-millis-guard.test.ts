// A seconds-valued `captured_at` put a row in 1970 (#9782).
//
// THE FAILURE IS SILENT BY CONSTRUCTION, which is the whole reason this needs a
// guard rather than a fix. `new Date(1785715160)` is a perfectly good Date --
// 1970-01-21 -- so a stamp missing its last three digits does not throw, does
// not warn, and produces a row keyed under a date fifty-six years in the past.
//
// The row is real: `updated_at` = 1785715160521 (correct ms) and `captured_at`
// = 1785715160 (the same instant, /1000) on one account_position_daily row.
// They describe the same moment and disagree by exactly 1000.
//
// It landed in an APPEND-ONLY table, so nothing revises it. It sits outside
// every served window and inside every COUNT(*), and it made that table's date
// range read `1970-01-21 .. 2026-08-07`.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  EPOCH_MS_FLOOR,
  isEpochMillis,
  neuronDailyRows,
  neuronSnapshotDate,
  netuidMaxCapturedAt,
} from "../src/neurons-neon-write.ts";

/** The exact value from the stranded production row. */
const STRANDED_SECONDS = 1785715160;
/** The same instant, correctly in milliseconds. */
const CORRECT_MS = 1785715160521;

describe("isEpochMillis", () => {
  test("separates the two populations with nothing legitimate between", () => {
    // 2026 in seconds is ~1.79e9; the floor is 1e12 (2001-09-09). Three orders
    // of magnitude apart, so the bound is not a close call.
    assert.equal(isEpochMillis(CORRECT_MS), true);
    assert.equal(isEpochMillis(STRANDED_SECONDS), false);
    assert.equal(isEpochMillis(EPOCH_MS_FLOOR), true);
    assert.equal(isEpochMillis(EPOCH_MS_FLOOR - 1), false);
  });

  test("rejects the shapes that reach a JSON body", () => {
    for (const value of [null, undefined, NaN, Infinity, -1, 0, "x", {}, []]) {
      assert.equal(isEpochMillis(value), false, String(value));
    }
  });
});

describe("neuronSnapshotDate", () => {
  test("returns null for the stranded value instead of 1970-01-21", () => {
    // The assertion that matters: the OLD behaviour was a valid-looking date.
    assert.equal(
      new Date(STRANDED_SECONDS).toISOString().slice(0, 10),
      "1970-01-21",
      "the value really does produce a plausible Date -- that is the trap",
    );
    assert.equal(neuronSnapshotDate(STRANDED_SECONDS), null);
  });

  test("still dates a correct stamp", () => {
    assert.equal(neuronSnapshotDate(CORRECT_MS), "2026-08-02");
  });

  test("the pair in the real row describe the same day, once one is fixed", () => {
    assert.equal(neuronSnapshotDate(STRANDED_SECONDS * 1000), "2026-08-02");
  });
});

describe("neuronDailyRows", () => {
  const row = (captured_at: number, uid = 0) => ({
    netuid: 1,
    uid,
    hotkey: `hk${uid}`,
    captured_at,
  });

  test("drops a row whose stamp is not milliseconds", () => {
    const out = neuronDailyRows(
      [row(CORRECT_MS, 0), row(STRANDED_SECONDS, 1), row(CORRECT_MS, 2)],
      9_999,
    );
    assert.equal(out.length, 2, "the bad row is dropped, the good ones kept");
    assert.deepEqual(
      out.map((r) => r.uid),
      [0, 2],
    );
    for (const r of out) assert.equal(r.snapshot_date, "2026-08-02");
  });

  test("dropping is the lesser loss, and the comment says why", () => {
    // Writing it would put a permanent 1970 row in an append-only table under a
    // key nothing else will ever write, so no later pass can revise it.
    const out = neuronDailyRows([row(STRANDED_SECONDS)], 1);
    assert.deepEqual(out, []);
  });

  test("a good batch is untouched", () => {
    const out = neuronDailyRows([row(CORRECT_MS, 0), row(CORRECT_MS, 1)], 42);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.updated_at, 42);
  });
});

describe("netuidMaxCapturedAt", () => {
  test("a seconds-valued stamp does not seed a prune cutoff", () => {
    // This map IS the prune cutoff. The seconds value is below every real row
    // so it deletes nothing on its own -- but it must not become the netuid's
    // cutoff either, and the check is the same question as the date's.
    const cutoffs = netuidMaxCapturedAt([
      { netuid: 1, captured_at: STRANDED_SECONDS },
      { netuid: 1, captured_at: CORRECT_MS },
      { netuid: 2, captured_at: STRANDED_SECONDS },
    ]);
    assert.equal(cutoffs.get(1), CORRECT_MS);
    assert.equal(
      cutoffs.has(2),
      false,
      "a netuid with only a bad stamp gets no cutoff, so its rows are not pruned against one",
    );
  });

  test("normal batches are unaffected", () => {
    const cutoffs = netuidMaxCapturedAt([
      { netuid: 1, captured_at: CORRECT_MS },
      { netuid: 1, captured_at: CORRECT_MS + 1000 },
    ]);
    assert.equal(cutoffs.get(1), CORRECT_MS + 1000);
  });
});
