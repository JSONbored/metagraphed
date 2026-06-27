import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeMinerReadiness,
  buildEconomicsArtifact,
} from "../scripts/lib/economics-artifacts.mjs";

// --- computeMinerReadiness --------------------------------------------------

describe("computeMinerReadiness", () => {
  test("nullish or non-object economics returns null", () => {
    assert.equal(computeMinerReadiness(null, 5, 0.1), null);
    assert.equal(computeMinerReadiness(undefined, 5, 0.1), null);
    assert.equal(computeMinerReadiness("not-an-object", 5, 0.1), null);
  });

  test("open registration + slots + cheap + active reaches the 100 ceiling", () => {
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
  });

  test("closed + full + expensive + inactive scores 0", () => {
    assert.equal(
      computeMinerReadiness(
        { registration_allowed: false, registration_cost_tao: 500 },
        0,
        0,
      ),
      0,
    );
  });

  test("registration_allowed alone contributes 40 (cost unknown adds 10)", () => {
    // registration_allowed (+40) + unknown cost (+10); no slots, inactive.
    assert.equal(
      computeMinerReadiness({ registration_allowed: true }, null, null),
      50,
    );
  });

  test("open UID slots contribute 30", () => {
    // registration (+40) + open slots (+30) + unknown cost (+10).
    assert.equal(
      computeMinerReadiness({ registration_allowed: true }, 5, null),
      80,
    );
    // openSlots must be a positive number — 0 and non-numbers add nothing.
    assert.equal(computeMinerReadiness({}, 0, null), 10);
    assert.equal(computeMinerReadiness({}, "5", null), 10);
  });

  test("registration cost tiers award 20 / 10 / 5 / 0", () => {
    assert.equal(computeMinerReadiness({ registration_cost_tao: 1 }, 0, 0), 20);
    assert.equal(
      computeMinerReadiness({ registration_cost_tao: 10 }, 0, 0),
      10,
    );
    assert.equal(
      computeMinerReadiness({ registration_cost_tao: 100 }, 0, 0),
      5,
    );
    assert.equal(
      computeMinerReadiness({ registration_cost_tao: 101 }, 0, 0),
      0,
    );
  });

  test("a missing or non-finite cost is treated as unknown (+10), not free", () => {
    assert.equal(computeMinerReadiness({}, null, null), 10);
    assert.equal(
      computeMinerReadiness({ registration_cost_tao: Number.NaN }, null, null),
      10,
    );
    assert.equal(
      computeMinerReadiness(
        { registration_cost_tao: Number.POSITIVE_INFINITY },
        null,
        null,
      ),
      10,
    );
  });

  test("activity is satisfied by positive emission share alone", () => {
    // unknown cost (+10) + active via emission share (+10).
    assert.equal(computeMinerReadiness({ total_stake_tao: 0 }, 0, 0.5), 20);
  });

  test("activity is satisfied by positive total stake alone", () => {
    // unknown cost (+10) + active via stake (+10).
    assert.equal(computeMinerReadiness({ total_stake_tao: 5 }, 0, 0), 20);
  });
});

// --- buildEconomicsArtifact -------------------------------------------------

function econSubnet(netuid, overrides = {}) {
  return {
    netuid,
    slug: `sn-${netuid}`,
    name: `Subnet ${netuid}`,
    ...overrides,
  };
}

describe("buildEconomicsArtifact", () => {
  test("empty subnet list yields an empty, well-formed artifact", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [],
      economicsByNetuid: new Map(),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    assert.equal(artifact.schema_version, 1);
    assert.equal(artifact.generated_at, "2026-06-25T00:00:00.000Z");
    assert.equal(artifact.network, null);
    assert.equal(artifact.captured_at, null);
    assert.deepEqual(artifact.subnets, []);
    assert.deepEqual(artifact.summary, {
      subnet_count: 0,
      with_economics_count: 0,
      total_stake_tao: 0,
      total_validators: 0,
      total_miners: 0,
      registration_open_count: 0,
    });
  });

  test("derives emission_share, open_slots, and miner_readiness for a row", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1)],
      economicsByNetuid: new Map([
        [
          1,
          {
            alpha_price_tao: 0.04,
            max_uids: 256,
            validator_count: 9,
            miner_count: 200,
            registration_allowed: true,
            registration_cost_tao: 0.5,
            total_stake_tao: 1000,
          },
        ],
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    const row = artifact.subnets[0];
    assert.equal(row.emission_share, 1); // only priced subnet → 100% of total
    assert.equal(row.open_slots, 47); // 256 − 9 − 200
    // 40 registration + 30 open slots + 20 cost≤1 + 10 active.
    assert.equal(row.miner_readiness, 100);
    assert.equal(row.netuid, 1);
    assert.equal(row.slug, "sn-1");
    assert.equal(artifact.summary.subnet_count, 1);
    assert.equal(artifact.summary.with_economics_count, 1);
    assert.equal(artifact.summary.total_stake_tao, 1000);
    assert.equal(artifact.summary.total_validators, 9);
    assert.equal(artifact.summary.total_miners, 200);
    assert.equal(artifact.summary.registration_open_count, 1);
  });

  test("subnets with no economics entry are omitted but still counted", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1), econSubnet(2)],
      economicsByNetuid: new Map([
        [1, { alpha_price_tao: 0.04, total_stake_tao: 5 }],
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    assert.equal(artifact.subnets.length, 1);
    assert.equal(artifact.subnets[0].netuid, 1);
    assert.equal(artifact.summary.subnet_count, 2);
    assert.equal(artifact.summary.with_economics_count, 1);
  });

  test("rows sort by emission_share descending", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1), econSubnet(2)],
      economicsByNetuid: new Map([
        [1, { alpha_price_tao: 1 }],
        [2, { alpha_price_tao: 3 }],
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    // total = 4 → shares 0.25 (sn1) and 0.75 (sn2); higher first.
    assert.deepEqual(
      artifact.subnets.map((row) => row.netuid),
      [2, 1],
    );
    assert.equal(artifact.subnets[0].emission_share, 0.75);
    assert.equal(artifact.subnets[1].emission_share, 0.25);
  });

  test("equal emission_share falls back to ascending netuid and rounds to 6 dp", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(3), econSubnet(1), econSubnet(2)],
      economicsByNetuid: new Map([
        [3, { alpha_price_tao: 1 }],
        [1, { alpha_price_tao: 1 }],
        [2, { alpha_price_tao: 1 }],
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    // Equal prices → identical shares, so only the netuid tiebreak orders them.
    assert.deepEqual(
      artifact.subnets.map((row) => row.netuid),
      [1, 2, 3],
    );
    // 1/3 is non-terminating → the 6-decimal rounding is what makes it exact.
    assert.equal(artifact.subnets[0].emission_share, 0.333333);
  });

  test("priced rows sort ahead of null-share rows, which order by netuid", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(5), econSubnet(3), econSubnet(1)],
      economicsByNetuid: new Map([
        [5, { total_stake_tao: 10 }], // no alpha price → null share
        [3, { total_stake_tao: 10 }], // no alpha price → null share
        [1, { alpha_price_tao: 0.04 }], // priced → sorts first
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    assert.deepEqual(
      artifact.subnets.map((row) => row.netuid),
      [1, 3, 5],
    );
    assert.deepEqual(
      artifact.subnets.map((row) => row.emission_share),
      [1, null, null],
    );
  });

  test("emission_share is null when the total alpha price is zero", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1)],
      economicsByNetuid: new Map([[1, { alpha_price_tao: 0 }]]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    assert.equal(artifact.subnets[0].emission_share, null);
  });

  test("open_slots is null without max_uids and clamps to zero when oversubscribed", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1), econSubnet(2)],
      economicsByNetuid: new Map([
        [1, { alpha_price_tao: 0.01 }], // no max_uids → open_slots null
        [
          2,
          {
            alpha_price_tao: 0.02,
            max_uids: 10,
            validator_count: 8,
            miner_count: 9,
          },
        ],
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    const byNetuid = new Map(artifact.subnets.map((row) => [row.netuid, row]));
    assert.equal(byNetuid.get(1).open_slots, null);
    assert.equal(byNetuid.get(2).open_slots, 0); // max(0, 10 − 17)
  });

  test("passes through network and captured_at metadata", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1)],
      economicsByNetuid: new Map([[1, { alpha_price_tao: 0.04 }]]),
      generatedAt: "2026-06-25T00:00:00.000Z",
      network: "test",
      capturedAt: "2026-06-24T00:00:00.000Z",
    });
    assert.equal(artifact.network, "test");
    assert.equal(artifact.captured_at, "2026-06-24T00:00:00.000Z");
  });

  test("registration_open_count counts only rows that allow registration", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1), econSubnet(2)],
      economicsByNetuid: new Map([
        [1, { alpha_price_tao: 0.01, registration_allowed: true }],
        [2, { alpha_price_tao: 0.02, registration_allowed: false }],
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    assert.equal(artifact.summary.registration_open_count, 1);
  });
});
