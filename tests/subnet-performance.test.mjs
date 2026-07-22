import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetPerformance,
  scoreDistribution,
  loadSubnetPerformance,
  parseSubnetPerformanceHistoryWindow,
  buildSubnetPerformanceHistory,
} from "../src/subnet-performance.ts";

// A neurons-tier snapshot for one subnet: two validators (permit=1) and two
// miners (permit=0), with a skewed incentive/dividend distribution.
const ROWS = [
  {
    incentive: 0.6,
    dividends: 0.5,
    trust: 0.9,
    consensus: 0.8,
    validator_trust: 0.95,
    active: 1,
    validator_permit: 1,
    captured_at: 1_750_000_000_000,
  },
  {
    incentive: 0.3,
    dividends: 0.1,
    trust: 0.7,
    consensus: 0.6,
    validator_trust: 0.85,
    active: 1,
    validator_permit: 1,
    captured_at: 1_750_000_000_000,
  },
  {
    incentive: 0.1,
    dividends: 0,
    trust: 0.4,
    consensus: 0.3,
    validator_trust: 0,
    active: 1,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
  },
  {
    incentive: 0,
    dividends: 0,
    trust: 0,
    consensus: 0,
    validator_trust: 0,
    active: 0,
    validator_permit: 0,
    captured_at: 1_750_000_000_000,
  },
];

describe("scoreDistribution", () => {
  test("computes count/mean/min/max + nearest-rank percentiles over 0..1 scores", () => {
    // A zero score is a real observation (kept), unlike concentration's positives.
    const d = scoreDistribution([0, 0.4, 0.7, 0.9]);
    assert.equal(d.count, 4);
    assert.equal(d.min, 0);
    assert.equal(d.max, 0.9);
    assert.equal(d.mean, 0.5);
    // nearest-rank: p50 rank = ceil(0.5·4)=2 → ascending[1]=0.4; p90 rank=ceil(3.6)=4 → 0.9
    assert.equal(d.p50, 0.4);
    assert.equal(d.p90, 0.9);
    assert.equal(d.p10, 0); // rank=ceil(0.4)=1 → ascending[0]
  });

  test("drops only null/NaN cells, coerces numeric strings", () => {
    const d = scoreDistribution([0.5, null, "0.25", undefined, NaN]);
    assert.equal(d.count, 2); // 0.5 and "0.25"
    assert.equal(d.min, 0.25);
    assert.equal(d.max, 0.5);
  });

  test("drops a whitespace-only cell instead of reading it as a real 0", () => {
    const d = scoreDistribution([0.5, " "]);
    assert.equal(d.count, 1); // the blank cell carries no real score
    assert.equal(d.mean, 0.5);
    assert.equal(d.min, 0.5);
  });

  test("empty / all-null column → null (schema-stable)", () => {
    assert.equal(scoreDistribution([]), null);
    assert.equal(scoreDistribution([null, undefined, "x"]), null);
    assert.equal(scoreDistribution("not-an-array"), null);
  });
});

describe("buildSubnetPerformance", () => {
  test("counts neurons/validators/active and stamps the newest captured_at", () => {
    const out = buildSubnetPerformance(ROWS, 7);
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, 7);
    assert.equal(out.neuron_count, 4);
    assert.equal(out.validator_count, 2);
    assert.equal(out.active_count, 3);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("incentive concentration is over ALL neurons with a positive incentive", () => {
    const out = buildSubnetPerformance(ROWS, 7);
    // incentives 0.6/0.3/0.1 are positive (the 0 is dropped) → 3 holders.
    assert.equal(out.incentive.holders, 3);
    assert.ok(out.incentive.gini > 0); // skewed
    assert.equal(out.incentive.nakamoto_coefficient, 1); // 0.6 of total 1.0 > 50%
  });

  test("dividends concentration is over the VALIDATORS only", () => {
    const out = buildSubnetPerformance(ROWS, 7);
    // Only the two validators earn dividends (0.5, 0.1); the miner rows are excluded.
    assert.equal(out.dividends.holders, 2);
    assert.equal(out.dividends.total, 0.6);
  });

  test("trust/consensus spread over all neurons; validator_trust over validators", () => {
    const out = buildSubnetPerformance(ROWS, 7);
    assert.equal(out.trust.count, 4); // all neurons
    assert.equal(out.consensus.count, 4);
    assert.equal(out.validator_trust.count, 2); // only the two validators
    assert.equal(out.trust.max, 0.9);
    assert.equal(out.validator_trust.min, 0.85); // 0.95/0.85 — miners excluded
  });

  test("accepts a string (ISO) captured_at and stamps the newest", () => {
    const out = buildSubnetPerformance(
      [
        { incentive: 0.2, captured_at: "2026-06-14T00:00:00.000Z" },
        { incentive: 0.3, captured_at: "2026-06-15T00:00:00.000Z" },
        { incentive: 0.1, captured_at: null }, // unstampable (not a string/number)
        { incentive: 0.1, captured_at: "not-a-date" }, // unparseable string → ignored
      ],
      7,
    );
    assert.equal(out.captured_at, "2026-06-15T00:00:00.000Z"); // newest of the two
  });

  test("rejects a zero/negative captured_at instead of stamping the 1970 epoch", () => {
    // A blank/sentinel D1 cell arrives as 0 (or negative). Alone it must yield a
    // null captured_at — never the 1970 epoch. Mirrors #2776/#2777.
    const zero = buildSubnetPerformance(
      [{ incentive: 0.5, captured_at: 0 }],
      7,
    );
    assert.equal(zero.captured_at, null);
    const negative = buildSubnetPerformance(
      [{ incentive: 0.5, captured_at: -5 }],
      7,
    );
    assert.equal(negative.captured_at, null);
    // …and a real timestamp still wins over the 0 sentinel when both are present.
    const mixed = buildSubnetPerformance(
      [
        { incentive: 0.5, captured_at: 0 },
        { incentive: 0.2, captured_at: 1_750_000_000_000 },
      ],
      7,
    );
    assert.equal(mixed.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("coerces a numeric-epoch string captured_at (D1 INTEGER as string)", () => {
    // D1 can return the INTEGER captured_at as a numeric string; Date.parse
    // returns NaN for a bare epoch string, so it was silently dropped.
    const out = buildSubnetPerformance(
      [{ incentive: 0.2, captured_at: "1750000000000" }],
      7,
    );
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
  });

  test("cold/empty subnet → schema-stable zero (every metric null)", () => {
    const out = buildSubnetPerformance([], 3);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.validator_count, 0);
    assert.equal(out.captured_at, null);
    assert.equal(out.incentive, null);
    assert.equal(out.dividends, null);
    assert.equal(out.trust, null);
    assert.equal(out.consensus, null);
    assert.equal(out.validator_trust, null);
  });

  test("null-safe on junk rows", () => {
    const out = buildSubnetPerformance("nope", 1);
    assert.equal(out.neuron_count, 0);
    assert.equal(out.incentive, null);
  });

  test("loadSubnetPerformance issues one netuid-scoped SELECT and shapes it", async () => {
    let seen;
    const d1 = async (sql, params) => {
      seen = { sql, params };
      return ROWS;
    };
    const out = await loadSubnetPerformance(d1, 7);
    assert.match(seen.sql, /FROM neurons WHERE netuid = \?/);
    assert.deepEqual(seen.params, [7]);
    assert.equal(out.netuid, 7);
    assert.equal(out.validator_count, 2);
  });
});

describe("parseSubnetPerformanceHistoryWindow", () => {
  test("accepts 7d / 30d / 90d", () => {
    assert.deepEqual(parseSubnetPerformanceHistoryWindow("7d"), {
      label: "7d",
      days: 7,
    });
    assert.deepEqual(parseSubnetPerformanceHistoryWindow("30d"), {
      label: "30d",
      days: 30,
    });
    assert.deepEqual(parseSubnetPerformanceHistoryWindow("90d"), {
      label: "90d",
      days: 90,
    });
  });

  test("defaults a missing/blank window to 30d", () => {
    assert.equal(parseSubnetPerformanceHistoryWindow(undefined).days, 30);
    assert.equal(parseSubnetPerformanceHistoryWindow("").days, 30);
    assert.equal(parseSubnetPerformanceHistoryWindow(null).days, 30);
  });

  test("rejects unsupported windows (incl. the longer history windows)", () => {
    for (const bad of ["1y", "all", "bogus", "0d"]) {
      const { error } = parseSubnetPerformanceHistoryWindow(bad);
      assert.equal(error.parameter, "window");
      assert.match(error.message, /7d, 30d, 90d/);
    }
  });
});

describe("buildSubnetPerformanceHistory", () => {
  test("computes a per-day reward-flow & trust trend, newest first", () => {
    // Rows arrive snapshot_date DESC (as the SQL returns them). The newest day is
    // reward-concentrated (one whale earner); the older day is an even split.
    const rows = [
      {
        snapshot_date: "2026-06-27",
        incentive: 0.9,
        dividends: 0.9,
        trust: 0.8,
        consensus: 0.7,
        validator_trust: 0.85,
        validator_permit: 1,
        active: 1,
      },
      {
        snapshot_date: "2026-06-27",
        incentive: 0.05,
        dividends: 0,
        trust: 0.2,
        consensus: 0.1,
        validator_trust: 0,
        validator_permit: 0,
        active: 1,
      },
      {
        snapshot_date: "2026-06-26",
        incentive: 0.5,
        dividends: 0.5,
        trust: 0.5,
        consensus: 0.5,
        validator_trust: 0.5,
        validator_permit: 1,
        active: 1,
      },
      {
        snapshot_date: "2026-06-26",
        incentive: 0.5,
        dividends: 0.5,
        trust: 0.5,
        consensus: 0.5,
        validator_trust: 0.5,
        validator_permit: 1,
        active: 1,
      },
    ];
    const data = buildSubnetPerformanceHistory(rows, 7, { window: "30d" });
    assert.equal(data.schema_version, 1);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.point_count, 2);
    assert.equal(data.points[0].snapshot_date, "2026-06-27"); // newest first
    assert.equal(data.points[1].snapshot_date, "2026-06-26");
    assert.equal(data.points[0].neuron_count, 2);
    assert.equal(data.points[0].validator_count, 1);
    assert.equal(data.points[0].active_count, 2);
    // The newest day's incentive is more concentrated than the even older day.
    assert.ok(data.points[0].incentive_gini > data.points[1].incentive_gini);
    assert.equal(data.points[1].incentive_gini, 0);
    assert.equal(typeof data.points[0].incentive_top_10pct_share, "number");
    assert.equal(typeof data.points[0].trust_mean, "number");
    assert.equal(typeof data.points[0].trust_median, "number");
    // Dividends + validator_trust are validator-only; the older day's two
    // validators split dividends evenly (gini 0).
    assert.equal(data.points[1].dividends_gini, 0);
    assert.equal(data.points[0].validator_trust_mean, 0.85);
  });

  test("drops the oldest (possibly partial) day when the read was capped", () => {
    const rows = [
      { snapshot_date: "2026-06-27", incentive: 0.5, validator_permit: 0 },
      { snapshot_date: "2026-06-26", incentive: 0.5, validator_permit: 0 },
    ];
    const data = buildSubnetPerformanceHistory(rows, 1, {
      window: "7d",
      capped: true,
    });
    assert.equal(data.point_count, 1);
    assert.equal(data.points[0].snapshot_date, "2026-06-27");
  });

  test("skips rows with no snapshot_date and is cold-store safe", () => {
    const data = buildSubnetPerformanceHistory(
      [
        { snapshot_date: null, incentive: 0.5 },
        { snapshot_date: "2026-06-27", incentive: 0.5, validator_permit: 0 },
      ],
      3,
      { window: "30d" },
    );
    assert.equal(data.point_count, 1);
    for (const rows of [[], "nope", null]) {
      const empty = buildSubnetPerformanceHistory(rows, 3, { window: "30d" });
      assert.equal(empty.point_count, 0);
      assert.deepEqual(empty.points, []);
      assert.equal(empty.window, "30d");
    }
  });

  test("an omitted window is emitted as null", () => {
    assert.equal(buildSubnetPerformanceHistory([], 5).window, null);
  });

  test("the *_median fields are the conventional median, not the lower-middle p50", () => {
    // An even neuron count: nearest-rank p50 would return the lower-middle value
    // (e.g. trust [0.2, 0.8] -> 0.2), but a field named *_median must be the
    // conventional median = average of the two middle values, matching the
    // median subnet-yield.mjs reports for median_yield.
    const day = (over) => ({
      snapshot_date: "2026-06-20",
      incentive: 0.1,
      dividends: 0.1,
      trust: 0.2,
      consensus: 0.1,
      validator_trust: 0.4,
      validator_permit: 1,
      active: 1,
      ...over,
    });
    const even = buildSubnetPerformanceHistory(
      [
        day({ trust: 0.2, consensus: 0.1, validator_trust: 0.4 }),
        day({ trust: 0.8, consensus: 0.9, validator_trust: 0.6 }),
      ],
      7,
    );
    const p = even.points[0];
    assert.equal(p.trust_median, 0.5); // (0.2 + 0.8) / 2, not the lower-middle 0.2
    assert.equal(p.consensus_median, 0.5); // (0.1 + 0.9) / 2
    assert.equal(p.validator_trust_median, 0.5); // (0.4 + 0.6) / 2, validators only

    // An odd count still returns the true middle value.
    const odd = buildSubnetPerformanceHistory(
      [day({ trust: 0.1 }), day({ trust: 0.4 }), day({ trust: 0.9 })],
      7,
    );
    assert.equal(odd.points[0].trust_median, 0.4);

    // A day with no finite scores keeps the field null (schema-stable).
    const none = buildSubnetPerformanceHistory([day({ trust: null })], 7);
    assert.equal(none.points[0].trust_median, null);
  });
});
