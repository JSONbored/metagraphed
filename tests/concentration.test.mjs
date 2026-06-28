import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeConcentration,
  buildConcentration,
  buildConcentrationHistory,
  loadSubnetConcentration,
  loadSubnetConcentrationHistory,
  parseConcentrationHistoryWindow,
} from "../src/concentration.mjs";

describe("computeConcentration", () => {
  test("returns null for an empty / non-array / all-zero distribution", () => {
    assert.equal(computeConcentration([]), null);
    assert.equal(computeConcentration(null), null);
    assert.equal(computeConcentration(undefined), null);
    assert.equal(computeConcentration([0, 0, 0]), null);
    assert.equal(computeConcentration([0, -3, Number.NaN, null]), null);
  });

  test("drops zero / negative / non-finite / null holders before measuring", () => {
    // Only 10, 5, and "3" (coerced) are positive holders.
    const c = computeConcentration([10, 0, -5, Number.NaN, null, 5, "3"]);
    assert.equal(c.holders, 3);
    assert.equal(c.total, 18);
  });

  test("a single holder is maximally concentrated (Gini 0 by definition)", () => {
    const c = computeConcentration([42]);
    assert.equal(c.holders, 1);
    assert.equal(c.total, 42);
    assert.equal(c.gini, 0); // one data point has no inequality
    assert.equal(c.hhi, 1);
    assert.equal(c.hhi_normalized, 1);
    assert.equal(c.nakamoto_coefficient, 1);
    assert.equal(c.top_1pct_share, 1);
    assert.equal(c.top_20pct_share, 1);
    assert.equal(c.entropy, 0);
    assert.equal(c.entropy_normalized, 0);
  });

  test("a perfectly uniform distribution has Gini 0 and full entropy", () => {
    const c = computeConcentration([5, 5, 5, 5]);
    assert.equal(c.gini, 0);
    assert.equal(c.hhi, 0.25); // 4 × 0.25²
    assert.equal(c.hhi_normalized, 0);
    assert.equal(c.nakamoto_coefficient, 3); // need 3 of 4 to exceed 50%
    assert.equal(c.entropy, 2); // log2(4)
    assert.equal(c.entropy_normalized, 1);
  });

  test("matches hand-computed stats for [1,2,3,4]", () => {
    const c = computeConcentration([1, 2, 3, 4]);
    assert.equal(c.total, 10);
    assert.equal(c.gini, 0.25);
    assert.equal(c.hhi, 0.3); // 0.1²+0.2²+0.3²+0.4²
    assert.equal(c.hhi_normalized, 0.066667); // (0.3−0.25)/0.75
    assert.equal(c.nakamoto_coefficient, 2); // 4+3 > 5
    // n=4: every percentile cutoff rounds up to the top holder.
    assert.equal(c.top_1pct_share, 0.4);
    assert.equal(c.top_20pct_share, 0.4);
    assert.ok(Math.abs(c.entropy - 1.846439) < 1e-5);
    assert.ok(Math.abs(c.entropy_normalized - 0.923219) < 1e-5);
  });

  test("percentile cutoffs differentiate on a larger distribution", () => {
    const c = computeConcentration([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert.equal(c.total, 55);
    assert.equal(c.gini, 0.3);
    assert.equal(c.nakamoto_coefficient, 4); // 10+9+8 = 27 ≤ 27.5; +7 > 27.5
    assert.equal(c.top_10pct_share, Math.round((10 / 55) * 1e6) / 1e6); // top 1 of 10
    assert.equal(c.top_20pct_share, Math.round((19 / 55) * 1e6) / 1e6); // top 2 of 10
    assert.ok(c.top_10pct_share < c.top_20pct_share);
  });

  test("a near-monopoly scores high Gini / HHI and low entropy", () => {
    const c = computeConcentration([1000, 1, 1, 1, 1]);
    assert.ok(c.gini > 0.7);
    assert.ok(c.hhi > 0.9);
    assert.equal(c.nakamoto_coefficient, 1);
    assert.ok(c.entropy_normalized < 0.2);
  });
});

describe("buildConcentration", () => {
  test("builds stake + emission scorecards and the newest stamp", () => {
    const rows = [
      { stake_tao: 10, emission_tao: 1, captured_at: "2026-06-26T01:00:00Z" },
      { stake_tao: 5, emission_tao: 0, captured_at: "2026-06-26T02:00:00Z" },
    ];
    const data = buildConcentration(rows, 7);
    assert.equal(data.schema_version, 1);
    assert.equal(data.netuid, 7);
    assert.equal(data.neuron_count, 2);
    assert.equal(data.captured_at, "2026-06-26T02:00:00Z"); // max, not row order
    assert.equal(data.stake.holders, 2);
    assert.equal(data.emission.holders, 1); // the 0-emission UID is dropped
  });

  test("cold / empty / non-array rows yield a schema-stable null block", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildConcentration(rows, 3);
      assert.equal(data.netuid, 3);
      assert.equal(data.neuron_count, 0);
      assert.equal(data.entity_count, 0);
      assert.equal(data.uids_per_entity, null);
      assert.equal(data.captured_at, null);
      assert.equal(data.stake, null);
      assert.equal(data.emission, null);
      assert.equal(data.entity_stake, null);
      assert.equal(data.entity_emission, null);
      assert.equal(data.validator_stake, null);
    }
  });

  test("collapses a coldkey's UIDs into one entity (true control view)", () => {
    // 3 UIDs, 2 coldkeys: A runs 2 hotkeys (10+30), B runs 1 (20).
    const rows = [
      { coldkey: "A", stake_tao: 10, emission_tao: 1, validator_permit: 1 },
      { coldkey: "A", stake_tao: 30, emission_tao: 3, validator_permit: 0 },
      { coldkey: "B", stake_tao: 20, emission_tao: 2, validator_permit: 1 },
    ];
    const data = buildConcentration(rows, 9);
    assert.equal(data.neuron_count, 3);
    assert.equal(data.entity_count, 2);
    assert.equal(data.uids_per_entity, 1.5); // 3 UIDs / 2 entities
    assert.equal(data.stake.holders, 3); // per-UID
    assert.equal(data.entity_stake.holders, 2); // A's two UIDs collapsed
    assert.equal(data.entity_stake.total, 60); // A=40, B=20
    // Validator-only: A's permitted UID (10) + B (20) — A's second UID has no permit.
    assert.equal(data.validator_stake.holders, 2);
    assert.equal(data.validator_stake.total, 30);
  });

  test("the entity lens exposes concentration the per-UID lens hides", () => {
    // One operator W runs 5 hotkeys of 20 (100 total); two solo holders of 1.
    const rows = [
      ...Array.from({ length: 5 }, () => ({ coldkey: "W", stake_tao: 20 })),
      { coldkey: "X", stake_tao: 1 },
      { coldkey: "Y", stake_tao: 1 },
    ];
    const data = buildConcentration(rows, 1);
    assert.equal(data.neuron_count, 7);
    assert.equal(data.entity_count, 3);
    // Per-UID, W looks like 5 medium holders; per-entity, W is one ~98% whale.
    assert.ok(data.entity_stake.gini > data.stake.gini);
    assert.equal(data.entity_stake.nakamoto_coefficient, 1); // W alone > 50%
    assert.ok(data.stake.nakamoto_coefficient > 1); // needs several UIDs
  });

  test("rows without a coldkey each count as their own entity", () => {
    const data = buildConcentration(
      [{ stake_tao: 10 }, { stake_tao: 20 }, { coldkey: "", stake_tao: 5 }],
      1,
    );
    assert.equal(data.entity_count, 3); // none merged (missing/empty coldkey)
    assert.equal(data.entity_stake.holders, 3);
  });

  test("converts D1 epoch-millisecond captured_at values to ISO strings", () => {
    const data = buildConcentration(
      [
        { stake_tao: 1, emission_tao: 1, captured_at: 1_750_000_000_000 },
        { stake_tao: 2, emission_tao: 2, captured_at: 1_750_000_060_000 },
      ],
      9,
    );
    assert.equal(data.captured_at, "2025-06-15T15:07:40.000Z");
  });

  test("tolerates rows missing captured_at / value columns", () => {
    const data = buildConcentration(
      [
        { stake_tao: 8 },
        { emission_tao: 2, captured_at: "2026-06-26T03:00:00Z" },
      ],
      1,
    );
    assert.equal(data.captured_at, "2026-06-26T03:00:00Z");
    assert.equal(data.stake.holders, 1);
    assert.equal(data.emission.holders, 1);
  });
});

describe("parseConcentrationHistoryWindow", () => {
  test("accepts 7d / 30d / 90d", () => {
    assert.deepEqual(parseConcentrationHistoryWindow("7d"), {
      label: "7d",
      days: 7,
    });
    assert.deepEqual(parseConcentrationHistoryWindow("30d"), {
      label: "30d",
      days: 30,
    });
    assert.deepEqual(parseConcentrationHistoryWindow("90d"), {
      label: "90d",
      days: 90,
    });
  });

  test("defaults a missing/blank window to 30d", () => {
    assert.equal(parseConcentrationHistoryWindow(undefined).days, 30);
    assert.equal(parseConcentrationHistoryWindow("").days, 30);
    assert.equal(parseConcentrationHistoryWindow(null).days, 30);
  });

  test("rejects unsupported windows (incl. the longer history windows)", () => {
    for (const bad of ["1y", "all", "bogus", "0d"]) {
      const { error } = parseConcentrationHistoryWindow(bad);
      assert.equal(error.parameter, "window");
      assert.match(error.message, /7d, 30d, 90d/);
    }
  });
});

describe("buildConcentrationHistory", () => {
  test("computes a per-day trend, newest first", () => {
    // Rows arrive snapshot_date DESC (as the SQL returns them).
    const rows = [
      { snapshot_date: "2026-06-27", stake_tao: 100, emission_tao: 10 },
      { snapshot_date: "2026-06-27", stake_tao: 1, emission_tao: 1 },
      { snapshot_date: "2026-06-27", stake_tao: 1, emission_tao: 1 },
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
      { snapshot_date: "2026-06-26", stake_tao: 50, emission_tao: 5 },
    ];
    const data = buildConcentrationHistory(rows, 7, { window: "30d" });
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.point_count, 2);
    assert.equal(data.points[0].snapshot_date, "2026-06-27"); // newest first
    assert.equal(data.points[1].snapshot_date, "2026-06-26");
    assert.equal(data.points[0].neuron_count, 3);
    // The newest day is concentrated (one whale); the older day is 50/50.
    assert.ok(data.points[0].stake_gini > data.points[1].stake_gini);
    assert.equal(data.points[1].stake_gini, 0);
    assert.equal(data.points[0].stake_nakamoto_coefficient, 1);
    assert.equal(typeof data.points[0].stake_top_10pct_share, "number");
    assert.equal(typeof data.points[0].emission_gini, "number");
  });

  test("drops the oldest (possibly partial) day when the read was capped", () => {
    const rows = [
      { snapshot_date: "2026-06-27", stake_tao: 10 },
      { snapshot_date: "2026-06-26", stake_tao: 5 },
    ];
    const data = buildConcentrationHistory(rows, 1, {
      window: "7d",
      capped: true,
    });
    assert.equal(data.point_count, 1);
    assert.equal(data.points[0].snapshot_date, "2026-06-27");
  });

  test("skips rows with no snapshot_date and is cold-store safe", () => {
    const data = buildConcentrationHistory(
      [
        { snapshot_date: null, stake_tao: 5 },
        { snapshot_date: "2026-06-27", stake_tao: 5 },
      ],
      1,
      {},
    );
    assert.equal(data.point_count, 1);
    for (const rows of [[], null, undefined]) {
      const empty = buildConcentrationHistory(rows, 3, { window: "30d" });
      assert.equal(empty.point_count, 0);
      assert.deepEqual(empty.points, []);
    }
  });
});

describe("concentration loaders", () => {
  function d1(rowsBySql = {}) {
    return async (sql, _params) => {
      for (const [pattern, rows] of Object.entries(rowsBySql)) {
        if (new RegExp(pattern).test(sql)) return rows;
      }
      return [];
    };
  }

  test("loadSubnetConcentration returns schema-stable null on cold D1", async () => {
    const data = await loadSubnetConcentration(d1(), 7);
    assert.equal(data.netuid, 7);
    assert.equal(data.neuron_count, 0);
    assert.equal(data.stake, null);
    assert.equal(data.emission, null);
  });

  test("loadSubnetConcentration builds scorecards from neurons rows", async () => {
    const data = await loadSubnetConcentration(
      d1({
        "FROM neurons": [
          {
            stake_tao: 100,
            emission_tao: 2,
            coldkey: "ck-a",
            validator_permit: 1,
            captured_at: "2026-06-27T00:00:00Z",
          },
          {
            stake_tao: 50,
            emission_tao: 1,
            coldkey: "ck-a",
            validator_permit: 0,
            captured_at: "2026-06-27T00:00:00Z",
          },
        ],
      }),
      7,
    );
    assert.equal(data.neuron_count, 2);
    assert.equal(data.entity_count, 1);
    assert.equal(data.stake.holders, 2);
    assert.equal(data.entity_stake.total, 150);
  });

  test("loadSubnetConcentrationHistory returns empty points on cold D1", async () => {
    const data = await loadSubnetConcentrationHistory(d1(), 7, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.point_count, 0);
    assert.deepEqual(data.points, []);
  });

  test("loadSubnetConcentrationHistory aggregates neuron_daily rows", async () => {
    const data = await loadSubnetConcentrationHistory(
      d1({
        "FROM neuron_daily": [
          { snapshot_date: "2026-06-02", stake_tao: 20, emission_tao: 2 },
          { snapshot_date: "2026-06-01", stake_tao: 10, emission_tao: 1 },
        ],
      }),
      7,
      { windowLabel: "7d", windowDays: 7 },
    );
    assert.equal(data.point_count, 2);
    assert.equal(data.points[0].snapshot_date, "2026-06-02");
    assert.ok(typeof data.points[0].stake_gini === "number");
  });
});
