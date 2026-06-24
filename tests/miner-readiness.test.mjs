import assert from "node:assert/strict";
import { test } from "vitest";
import {
  computeMinerReadiness,
  buildEconomicsArtifact,
} from "../scripts/lib.mjs";

test("computeMinerReadiness scores joinability 0-100 (#1306)", () => {
  // Open registration + free slots + cheap + active → max.
  assert.equal(
    computeMinerReadiness(
      {
        registration_allowed: true,
        registration_cost_tao: 0.5,
        total_stake_tao: 100,
      },
      50,
      0.01,
    ),
    100,
  );
  // Closed + full + expensive + inactive → 0.
  assert.equal(
    computeMinerReadiness(
      { registration_allowed: false, registration_cost_tao: 500 },
      0,
      0,
    ),
    0,
  );
  // Open but full (no slots) + moderate cost + active → 40+10+10.
  assert.equal(
    computeMinerReadiness(
      {
        registration_allowed: true,
        registration_cost_tao: 5,
        total_stake_tao: 10,
      },
      0,
      null,
    ),
    60,
  );
  assert.equal(computeMinerReadiness(null, 5, 0.1), null);

  // A non-finite cost (NaN/Infinity) is "unknown", not free: it must take the
  // +10 unknown-cost path, not slip past a typeof check and score 0 cost points.
  // open + slots + unknown-cost + active → 40+30+10+10.
  assert.equal(
    computeMinerReadiness(
      {
        registration_allowed: true,
        registration_cost_tao: Number.NaN,
        total_stake_tao: 100,
      },
      50,
      0.01,
    ),
    90,
  );
});

test("buildEconomicsArtifact derives open_slots + miner_readiness (#1306)", () => {
  const subnets = [{ netuid: 1, slug: "apex", name: "Apex" }];
  const economicsByNetuid = new Map([
    [
      1,
      {
        max_uids: 256,
        validator_count: 9,
        miner_count: 200,
        registration_allowed: true,
        registration_cost_tao: 0.5,
        total_stake_tao: 1000,
        alpha_price_tao: 0.04,
      },
    ],
  ]);
  const art = buildEconomicsArtifact({
    subnets,
    economicsByNetuid,
    generatedAt: "1970-01-01T00:00:00.000Z",
  });
  const row = art.subnets[0];
  assert.equal(row.open_slots, 47); // 256 − 9 − 200
  assert.ok(row.miner_readiness >= 0 && row.miner_readiness <= 100);
  assert.equal(typeof row.miner_readiness, "number");
});
