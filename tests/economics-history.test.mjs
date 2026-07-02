import assert from "node:assert/strict";
import { test } from "vitest";
import { formatTrajectory } from "../src/health-serving.mjs";

// #1307: the daily subnet_snapshots rollup now carries per-subnet economics, so
// the trajectory time series exposes economic trends alongside the structural ones.
test("formatTrajectory carries economic fields in the time series (#1307)", () => {
  const rows = [
    {
      snapshot_date: "2026-06-20",
      completeness_score: 80,
      surface_count: 5,
      endpoint_count: 3,
      validator_count: 9,
      miner_count: 247,
      total_stake_tao: 2522266,
      alpha_price_tao: 0.04,
      emission_share: 0.01,
    },
    {
      snapshot_date: "2026-06-21",
      completeness_score: 82,
      surface_count: 6,
      endpoint_count: 4,
      validator_count: 10,
      miner_count: 246,
      total_stake_tao: 2600000,
      alpha_price_tao: 0.05,
      emission_share: 0.011,
    },
  ];
  const out = formatTrajectory({ netuid: 1, rows });
  assert.equal(out.point_count, 2);
  const latest = out.points[1];
  assert.equal(latest.date, "2026-06-21");
  assert.equal(latest.validator_count, 10);
  assert.equal(latest.miner_count, 246);
  assert.equal(latest.total_stake_tao, 2600000);
  assert.equal(latest.alpha_price_tao, 0.05);
  assert.equal(latest.emission_share, 0.011);
  // structural fields still present.
  assert.equal(latest.completeness_score, 82);
});

test("formatTrajectory nulls economics on pre-migration rows", () => {
  const out = formatTrajectory({
    netuid: 1,
    rows: [{ snapshot_date: "2026-06-01", completeness_score: 70 }],
  });
  assert.equal(out.points[0].validator_count, null);
  assert.equal(out.points[0].total_stake_tao, null);
  assert.equal(out.points[0].alpha_price_tao, null);
});
