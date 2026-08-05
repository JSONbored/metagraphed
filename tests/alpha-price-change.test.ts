import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeAlphaPriceChanges,
  indexAlphaPriceHistoryByNetuid,
  normalizeAlphaPricePoints,
  pctChange,
  withAlphaPriceChanges,
} from "../src/alpha-price-change.ts";

describe("pctChange", () => {
  test("returns signed %-change rounded to 2dp", () => {
    assert.equal(pctChange(1, 1.1), 10);
    assert.equal(pctChange(2, 1), -50);
    assert.equal(pctChange(1, 1.005), 0.5);
  });

  test("null when start/end non-finite or start is zero", () => {
    assert.equal(pctChange(0, 1), null);
    assert.equal(pctChange(null as unknown as number, 1), null);
    assert.equal(pctChange(undefined as unknown as number, 1), null);
    assert.equal(pctChange(1, null as unknown as number), null);
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
    assert.equal(
      computeAlphaPriceChanges("nope" as unknown as Record<string, unknown>[])
        .alpha_price_change_1d,
      null,
    );
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
      [{ date: "2026-06-01", alpha_price_tao: 1, captured_at: null }],
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
      ] as unknown as Record<string, unknown>[]),
      [
        { date: "2026-06-01", alpha_price_tao: 1, captured_at: null },
        { date: "2026-06-02", alpha_price_tao: 1.5, captured_at: null },
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
    assert.equal(map.get(1)!.length, 2);
    assert.equal(map.get(2)![0].alpha_price_tao, 2);
    assert.equal(indexAlphaPriceHistoryByNetuid(null).size, 0);
    assert.equal(indexAlphaPriceHistoryByNetuid(undefined).size, 0);
    assert.equal(
      indexAlphaPriceHistoryByNetuid(
        "nope" as unknown as Record<string, unknown>[],
      ).size,
      0,
    );
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

// #9449: the window is measured on a real clock, not by calendar-date
// subtraction.
//
// THE BUG THIS PINS, reproduced from live production data. Snapshot rows are
// upserted throughout their own day, so the row dated "today" holds a
// measurement from minutes ago while the row dated "yesterday" holds
// yesterday's LAST one. On 2026-08-05 the 08-05 row was captured 00:00:08 and
// the 08-04 row 23:00:08 -- ONE HOUR apart. The economics source they both
// read refreshes every ~3h, so both carried a byte-identical price, and the
// date-based lookup reported `alpha_price_change_1d` as exactly 0 for ALL 129
// subnets. Zero, not null: a consumer plots that as "flat", which is a
// confident wrong answer rather than a missing one.
describe("#9449 — windows measured by captured_at, not by date arithmetic", () => {
  const at = (iso: string) => Date.parse(iso);

  // The exact live shape: netuid 64's last four snapshot rows.
  const production = [
    {
      snapshot_date: "2026-08-02",
      alpha_price_tao: 0.083135901,
      captured_at: at("2026-08-02T23:00:05Z"),
    },
    {
      snapshot_date: "2026-08-03",
      alpha_price_tao: 0.084084102,
      captured_at: at("2026-08-03T23:00:14Z"),
    },
    {
      snapshot_date: "2026-08-04",
      alpha_price_tao: 0.084773044,
      captured_at: at("2026-08-04T23:00:08Z"),
    },
    {
      snapshot_date: "2026-08-05",
      alpha_price_tao: 0.084773044,
      captured_at: at("2026-08-05T00:00:08Z"),
    },
  ];

  test("does not report 0 for two rows measured an hour apart", () => {
    const changes = computeAlphaPriceChanges(production);
    // The old date-based lookup picked the 08-04 row (one hour earlier, same
    // price) and returned exactly 0.
    assert.notEqual(changes.alpha_price_change_1d, 0);
    // 08-03 is the newest row at least 24h before 08-05 00:00:08.
    assert.equal(
      changes.alpha_price_change_1d,
      pctChange(0.084084102, 0.084773044),
    );
    assert.equal(changes.alpha_price_change_1d, 0.82);
  });

  test("null, not 0, when history does not reach back far enough", () => {
    // "We cannot measure this window" and "the price did not move" are
    // different statements, and only one of them is safe to plot.
    const changes = computeAlphaPriceChanges([
      {
        snapshot_date: "2026-08-05",
        alpha_price_tao: 1,
        captured_at: at("2026-08-05T00:00:00Z"),
      },
      {
        snapshot_date: "2026-08-05",
        alpha_price_tao: 1,
        captured_at: at("2026-08-05T01:00:00Z"),
      },
    ]);
    assert.equal(changes.alpha_price_change_1d, null);
    assert.equal(changes.alpha_price_change_7d, null);
  });

  test("a row with no captured_at counts as END of its day", () => {
    // Untimestamped historical rows are what the live writer's last upsert of
    // a day represents (~23:00), so midnight would overstate every gap by
    // nearly a full day and silently shift which row each window picks.
    const changes = computeAlphaPriceChanges([
      { snapshot_date: "2026-08-03", alpha_price_tao: 1 },
      { snapshot_date: "2026-08-04", alpha_price_tao: 2 },
      {
        snapshot_date: "2026-08-05",
        alpha_price_tao: 4,
        captured_at: at("2026-08-05T23:30:00Z"),
      },
    ]);
    // 24h before 08-05T23:30 is 08-04T23:30; the 08-04 row counts as
    // 08-04T23:59:59.999, which is AFTER that, so 08-03 is the correct pick.
    assert.equal(changes.alpha_price_change_1d, pctChange(1, 4));
  });

  test("the window still works late in the day, when dates would also agree", () => {
    // The old logic was right at end-of-day and wrong at start-of-day; the fix
    // must not break the case that used to work.
    const changes = computeAlphaPriceChanges([
      {
        snapshot_date: "2026-08-04",
        alpha_price_tao: 2,
        captured_at: at("2026-08-04T23:00:00Z"),
      },
      {
        snapshot_date: "2026-08-05",
        alpha_price_tao: 3,
        captured_at: at("2026-08-05T23:00:00Z"),
      },
    ]);
    assert.equal(changes.alpha_price_change_1d, pctChange(2, 3));
  });

  test("indexAlphaPriceHistoryByNetuid carries captured_at through", () => {
    // The seam where the fix would silently stop working: drop the column here
    // and every row falls back to end-of-day.
    const indexed = indexAlphaPriceHistoryByNetuid([
      {
        netuid: 64,
        snapshot_date: "2026-08-05",
        alpha_price_tao: 1,
        captured_at: 123,
      },
    ]);
    assert.equal(indexed.get(64)?.[0]?.captured_at, 123);
  });
});
