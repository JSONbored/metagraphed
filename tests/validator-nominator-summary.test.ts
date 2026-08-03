import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
  fillConfirmedZeros,
  nominatorCountsByHotkey,
} from "../src/validator-nominator-summary.ts";

describe("nominatorCountsByHotkey", () => {
  test("builds a hotkey -> nominator_count Map from rows", () => {
    const map = nominatorCountsByHotkey([
      { hotkey: "5Hk1", nominator_count: 42, captured_at: 1_700_000_000_000 },
      { hotkey: "5Hk2", nominator_count: 0, captured_at: 1_700_000_000_000 },
    ]);
    assert.equal(map.get("5Hk1"), 42);
    assert.equal(map.get("5Hk2"), 0);
    assert.equal(map.size, 2);
  });

  test("is cold-safe for non-array/empty input", () => {
    assert.equal(nominatorCountsByHotkey(null).size, 0);
    assert.equal(nominatorCountsByHotkey(undefined).size, 0);
    assert.equal(nominatorCountsByHotkey([]).size, 0);
    assert.equal(
      nominatorCountsByHotkey(
        "not-an-array" as unknown as Parameters<
          typeof nominatorCountsByHotkey
        >[0],
      ).size,
      0,
    );
  });

  test("skips a row with a missing/blank hotkey", () => {
    const map = nominatorCountsByHotkey([
      { hotkey: "", nominator_count: 5 },
      { hotkey: null, nominator_count: 5 },
      { nominator_count: 5 },
    ]);
    assert.equal(map.size, 0);
  });

  test("skips a row with a non-integer or negative nominator_count", () => {
    const map = nominatorCountsByHotkey([
      { hotkey: "5Hk1", nominator_count: -1 },
      { hotkey: "5Hk2", nominator_count: 1.5 },
      { hotkey: "5Hk3", nominator_count: "abc" },
      { hotkey: "5Hk4", nominator_count: null },
    ]);
    assert.equal(map.size, 0);
  });

  test("skips a malformed (non-object) row", () => {
    const map = nominatorCountsByHotkey([
      null,
      undefined,
      "row",
      42,
    ] as unknown as Parameters<typeof nominatorCountsByHotkey>[0]);
    assert.equal(map.size, 0);
  });
});

describe("VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS", () => {
  test("is the exact three-column shape the migration/sync endpoint expect", () => {
    assert.deepEqual(VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS, [
      "hotkey",
      "nominator_count",
      "captured_at",
    ]);
  });
});

// --- fillConfirmedZeros (#9314) ----------------------------------------------
//
// The rule that turns "no row" into a real 0, and the gate that stops it from
// doing so on stale data. Unit-tested directly rather than only through the
// route, because two of its branches (an empty batch, an unusable scan stamp)
// cannot be produced by the real query -- `hotkey` is TEXT NOT NULL and the
// stamp is a scalar subselect -- and a guard that cannot be reached is a guard
// nobody has checked.
describe("fillConfirmedZeros", () => {
  const HOUR = 3_600_000;
  const THRESHOLD = 30 * HOUR;
  const NOW = 1_785_800_000_000;
  const row = (hotkey: string, scanAt: unknown) => ({
    hotkey,
    scan_at: scanAt,
  });

  test("a fresh scan turns every uncounted hotkey into a confirmed zero", () => {
    const rows = [row("5A", NOW - HOUR), row("5B", NOW - HOUR)];
    const counts = fillConfirmedZeros(
      rows,
      new Map([["5A", 42]]),
      NOW,
      THRESHOLD,
    );
    assert.equal(counts.get("5A"), 42, "a real count is never overwritten");
    assert.equal(counts.get("5B"), 0);
  });

  test("a stale scan fills nothing", () => {
    const rows = [row("5A", NOW - 31 * HOUR)];
    const counts = fillConfirmedZeros(rows, new Map(), NOW, THRESHOLD);
    assert.equal(counts.size, 0, "absence means unknown, not zero");
  });

  test("exactly at the threshold still counts as fresh", () => {
    const rows = [row("5A", NOW - THRESHOLD)];
    assert.equal(
      fillConfirmedZeros(rows, new Map(), NOW, THRESHOLD).get("5A"),
      0,
    );
  });

  test("an empty batch, a null stamp and a non-numeric stamp all fill nothing", () => {
    assert.equal(fillConfirmedZeros([], new Map(), NOW, THRESHOLD).size, 0);
    assert.equal(fillConfirmedZeros(null, new Map(), NOW, THRESHOLD).size, 0);
    assert.equal(
      fillConfirmedZeros(undefined, new Map(), NOW, THRESHOLD).size,
      0,
    );
    // Number(null) is 0 -- the epoch -- so this is refused by the freshness
    // check rather than the finite check; both paths must refuse it.
    assert.equal(
      fillConfirmedZeros([row("5A", null)], new Map(), NOW, THRESHOLD).size,
      0,
      "a table with no scan at all invents nothing",
    );
    assert.equal(
      fillConfirmedZeros([row("5A", "nonsense")], new Map(), NOW, THRESHOLD)
        .size,
      0,
    );
  });

  test("a row whose hotkey is not a string is skipped, not coerced", () => {
    const rows = [
      { hotkey: 5, scan_at: NOW } as unknown as Record<string, unknown>,
      row("5B", NOW),
    ];
    const counts = fillConfirmedZeros(rows, new Map(), NOW, THRESHOLD);
    assert.equal(counts.size, 1);
    assert.equal(counts.get("5B"), 0);
  });
});
