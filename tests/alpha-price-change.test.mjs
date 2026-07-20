import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeAlphaPriceChanges,
  indexAlphaPriceHistoryByNetuid,
  normalizeAlphaPricePoints,
  pctChange,
  withAlphaPriceChanges,
} from "../src/alpha-price-change.mjs";

describe("pctChange", () => {
  test("returns signed %-change rounded to 2dp", () => {
    assert.equal(pctChange(1, 1.1), 10);
    assert.equal(pctChange(2, 1), -50);
    assert.equal(pctChange(1, 1.005), 0.5);
  });

  test("null when start/end non-finite or start is zero", () => {
    assert.equal(pctChange(0, 1), null);
    assert.equal(pctChange(null, 1), null);
    assert.equal(pctChange(undefined, 1), null);
    assert.equal(pctChange(1, null), null);
    assert.equal(pctChange(1, Number.NaN), null);
    assert.equal(pctChange(Number.POSITIVE_INFINITY, 1), null);
    assert.equal(pctChange(1, Number.POSITIVE_INFINITY), null);
  });
});

describe("computeAlphaPriceChanges", () => {
  test("always returns all four keys; 1h is always null", () => {
    const out = computeAlphaPriceChanges([]);
    assert.deepEqual(out, {
      alpha_price_change_1h: null,
      alpha_price_change_1d: null,
      alpha_price_change_7d: null,
      alpha_price_change_1m: null,
    });
  });

  test("null for a non-array / missing series", () => {
    assert.equal(computeAlphaPriceChanges(null).alpha_price_change_1d, null);
    assert.equal(
      computeAlphaPriceChanges(undefined).alpha_price_change_1d,
      null,
    );
    assert.equal(computeAlphaPriceChanges("nope").alpha_price_change_1d, null);
  });

  test("computes 1d/7d/1m from daily snapshots; insufficient history → null", () => {
    const rows = [
      { snapshot_date: "2026-06-01", alpha_price_tao: 1 },
      { snapshot_date: "2026-06-14", alpha_price_tao: 1.1 },
      { snapshot_date: "2026-06-20", alpha_price_tao: 1.2 },
      { snapshot_date: "2026-06-21", alpha_price_tao: 1.5 },
    ];
    const out = computeAlphaPriceChanges(rows);
    assert.equal(out.alpha_price_change_1h, null);
    // 1d: prior on/before 2026-06-20 → 1.2 → (1.5-1.2)/1.2 = 25%
    assert.equal(out.alpha_price_change_1d, 25);
    // 7d: prior on/before 2026-06-14 → 1.1 → (1.5-1.1)/1.1 ≈ 36.36
    assert.equal(out.alpha_price_change_7d, 36.36);
    // 1m (30d): prior on/before 2026-05-22 — none → null
    assert.equal(out.alpha_price_change_1m, null);
  });

  test("computes 1m when ≥30d of history exists", () => {
    const rows = [
      { snapshot_date: "2026-05-20", alpha_price_tao: 1 },
      { snapshot_date: "2026-06-19", alpha_price_tao: 2 },
    ];
    // 1m from 06-19 → target 05-20 → +100%
    assert.equal(computeAlphaPriceChanges(rows).alpha_price_change_1m, 100);
  });

  test("uses point-at-or-before when the exact lookback day is missing", () => {
    const rows = [
      { date: "2026-06-01", alpha_price_tao: 2 },
      { date: "2026-06-10", alpha_price_tao: 2.5 },
      { date: "2026-06-20", alpha_price_tao: 3 },
    ];
    // 7d from 06-20 → target 06-13; latest ≤06-13 is 06-10 at 2.5 → +20%
    assert.equal(computeAlphaPriceChanges(rows).alpha_price_change_7d, 20);
  });

  test("skips non-finite prices when picking latest/prior", () => {
    const rows = [
      { snapshot_date: "2026-06-19", alpha_price_tao: 1 },
      { snapshot_date: "2026-06-20", alpha_price_tao: null },
      { snapshot_date: "2026-06-21", alpha_price_tao: "bad" },
    ];
    // Latest finite is 06-19; no earlier prior → all windows null
    assert.deepEqual(computeAlphaPriceChanges(rows), {
      alpha_price_change_1h: null,
      alpha_price_change_1d: null,
      alpha_price_change_7d: null,
      alpha_price_change_1m: null,
    });
  });

  test("skips a null-priced point when selecting the lookback prior", () => {
    const rows = [
      { snapshot_date: "2026-06-01", alpha_price_tao: null },
      { snapshot_date: "2026-06-10", alpha_price_tao: 1 },
      { snapshot_date: "2026-06-12", alpha_price_tao: "" },
      { snapshot_date: "2026-06-20", alpha_price_tao: 2 },
    ];
    // 7d from 06-20 → target 06-13; skip null/blank, prior is 06-10 → +100%
    assert.equal(computeAlphaPriceChanges(rows).alpha_price_change_7d, 100);
  });

  test("rejects non-YYYY-MM-DD date prefixes", () => {
    assert.deepEqual(
      normalizeAlphaPricePoints([
        { date: "2026", alpha_price_tao: 1 },
        { date: "2026-03", alpha_price_tao: 1 },
        { date: "2026-06-01", alpha_price_tao: 1 },
      ]),
      [{ date: "2026-06-01", alpha_price_tao: 1 }],
    );
  });
});

describe("normalizeAlphaPricePoints / index / withAlphaPriceChanges", () => {
  test("normalize sorts ascending and coerces prices", () => {
    assert.deepEqual(
      normalizeAlphaPricePoints([
        { snapshot_date: "2026-06-02", alpha_price_tao: "1.5" },
        { date: "2026-06-01", alpha_price_tao: 1 },
        null,
        "skip",
        { snapshot_date: "", alpha_price_tao: 9 },
        { snapshot_date: null, alpha_price_tao: 9 },
        { alpha_price_tao: 9 },
      ]),
      [
        { date: "2026-06-01", alpha_price_tao: 1 },
        { date: "2026-06-02", alpha_price_tao: 1.5 },
      ],
    );
    assert.deepEqual(normalizeAlphaPricePoints(null), []);
    assert.deepEqual(normalizeAlphaPricePoints(undefined), []);
  });

  test("indexAlphaPriceHistoryByNetuid groups by netuid and skips junk", () => {
    const map = indexAlphaPriceHistoryByNetuid([
      { netuid: 1, snapshot_date: "2026-06-01", alpha_price_tao: 1 },
      { netuid: 2, date: "2026-06-01", alpha_price_tao: 2 },
      { netuid: 1, snapshot_date: "2026-06-02", alpha_price_tao: 1.1 },
      { netuid: "bad", snapshot_date: "2026-06-01", alpha_price_tao: 9 },
      { netuid: -1, snapshot_date: "2026-06-01", alpha_price_tao: 9 },
      { netuid: 1.5, snapshot_date: "2026-06-01", alpha_price_tao: 9 },
      { netuid: 3, snapshot_date: "", alpha_price_tao: 9 },
      { netuid: 3, date: null, alpha_price_tao: 9 },
      { netuid: 3, alpha_price_tao: 9 },
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.get(1).length, 2);
    assert.equal(map.get(2)[0].alpha_price_tao, 2);
    assert.equal(indexAlphaPriceHistoryByNetuid(null).size, 0);
    assert.equal(indexAlphaPriceHistoryByNetuid(undefined).size, 0);
    assert.equal(indexAlphaPriceHistoryByNetuid("nope").size, 0);
  });

  test("withAlphaPriceChanges always attaches the four keys", () => {
    const out = withAlphaPriceChanges({ netuid: 1, alpha_price_tao: 1.5 }, [
      { snapshot_date: "2026-06-20", alpha_price_tao: 1 },
      { snapshot_date: "2026-06-21", alpha_price_tao: 1.5 },
    ]);
    assert.equal(out.netuid, 1);
    assert.equal(out.alpha_price_tao, 1.5);
    assert.equal(out.alpha_price_change_1h, null);
    assert.equal(out.alpha_price_change_1d, 50);
    assert.equal(out.alpha_price_change_7d, null);
    assert.equal(out.alpha_price_change_1m, null);
  });

  test("withAlphaPriceChanges tolerates a null economics row", () => {
    const out = withAlphaPriceChanges(null, []);
    assert.equal(out.alpha_price_change_1h, null);
    assert.equal(out.alpha_price_change_1d, null);
    assert.equal(out.alpha_price_change_7d, null);
    assert.equal(out.alpha_price_change_1m, null);
  });
});
