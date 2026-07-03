import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetPerformance,
  scoreDistribution,
  loadSubnetPerformance,
} from "../src/subnet-performance.mjs";

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
