import assert from "node:assert/strict";
import { test } from "vitest";
import { formatTrajectory } from "../src/health-serving.ts";
import type { Row } from "./row-type.ts";

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
  const latest = (out as Row).points[1];
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
  assert.equal((out as Row).points[0].validator_count, null);
  assert.equal((out as Row).points[0].total_stake_tao, null);
  assert.equal((out as Row).points[0].alpha_price_tao, null);
});

// #2552: pool reserves + volume carried in the time series alongside the
// other economics columns.
test("formatTrajectory carries pool liquidity + volume fields in the time series (#2552)", () => {
  const out = formatTrajectory({
    netuid: 1,
    rows: [
      {
        snapshot_date: "2026-06-21",
        tao_in_pool_tao: 26707.57,
        alpha_in_pool: 2956464.98,
        alpha_out_pool: 2257199.02,
        subnet_volume_tao: 798027.45,
      },
    ],
  });
  const point = (out as Row).points[0];
  assert.equal(point.tao_in_pool_tao, 26707.57);
  assert.equal(point.alpha_in_pool, 2956464.98);
  assert.equal(point.alpha_out_pool, 2257199.02);
  assert.equal(point.subnet_volume_tao, 798027.45);
});

test("formatTrajectory nulls pool liquidity + volume on pre-migration rows (#2552)", () => {
  const out = formatTrajectory({
    netuid: 1,
    rows: [{ snapshot_date: "2026-06-01", completeness_score: 70 }],
  });
  assert.equal((out as Row).points[0].tao_in_pool_tao, null);
  assert.equal((out as Row).points[0].alpha_in_pool, null);
  assert.equal((out as Row).points[0].alpha_out_pool, null);
  assert.equal((out as Row).points[0].subnet_volume_tao, null);
});

// #2552's core deliverable: "net TAO in/out flow" is the windowed delta of
// the point-in-time pool reserves, not a separately-ingested metric.
test("formatTrajectory's 7d/30d deltas report net pool flow (#2552)", () => {
  const out = formatTrajectory({
    netuid: 1,
    rows: [
      {
        snapshot_date: "2026-05-20",
        tao_in_pool_tao: 20000,
        alpha_in_pool: 2900000,
        alpha_out_pool: 2200000,
      },
      {
        snapshot_date: "2026-06-14",
        tao_in_pool_tao: 24000,
        alpha_in_pool: 2940000,
        alpha_out_pool: 2230000,
      },
      {
        snapshot_date: "2026-06-21",
        tao_in_pool_tao: 26707.57,
        alpha_in_pool: 2956464.98,
        alpha_out_pool: 2257199.02,
      },
    ],
  });
  const delta7d = (out as Row).deltas["7d"];
  assert.equal(delta7d.from_date, "2026-06-14");
  assert.equal(delta7d.to_date, "2026-06-21");
  assert.ok(Math.abs(delta7d.tao_in_pool_tao - 2707.57) < 1e-6);
  assert.ok(Math.abs(delta7d.alpha_in_pool - 16464.98) < 1e-6);
  assert.ok(Math.abs(delta7d.alpha_out_pool - 27199.02) < 1e-6);

  const delta30d = (out as Row).deltas["30d"];
  assert.equal(delta30d.from_date, "2026-05-20");
  assert.equal(delta30d.to_date, "2026-06-21");
  assert.ok(Math.abs(delta30d.tao_in_pool_tao - 6707.57) < 1e-6);
});

test("formatTrajectory's deltas are null when a bound is missing a pool reading (#2552)", () => {
  const out = formatTrajectory({
    netuid: 1,
    rows: [
      { snapshot_date: "2026-05-20", tao_in_pool_tao: null },
      {
        snapshot_date: "2026-06-21",
        tao_in_pool_tao: 26707.57,
        alpha_in_pool: 2956464.98,
      },
    ],
  });
  assert.equal((out as Row).deltas["30d"].tao_in_pool_tao, null);
  assert.equal((out as Row).deltas["30d"].alpha_out_pool, null);
});
