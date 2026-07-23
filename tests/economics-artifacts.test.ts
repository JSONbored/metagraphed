import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ALPHA_MAX_SUPPLY,
  computeAlphaFdvTao,
  computeAlphaMarketCapTao,
  computeMinerReadiness,
  computeNetworkValueSummary,
  buildEconomicsArtifact,
} from "../scripts/lib/economics-artifacts.ts";
import type { Row } from "./row-type.ts";

// --- computeMinerReadiness --------------------------------------------------

describe("computeMinerReadiness", () => {
  test("nullish or non-object economics returns null", () => {
    assert.equal(computeMinerReadiness(null, 5, 0.1), null);
    assert.equal(computeMinerReadiness(undefined, 5, 0.1), null);
    assert.equal(
      computeMinerReadiness(
        "not-an-object" as unknown as Record<string, unknown>,
        5,
        0.1,
      ),
      null,
    );
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
    // A non-finite cost in an otherwise-strong subnet still scores through the
    // unknown-cost path: 40 + 30 + 10 + 10 = 90, never a free zero-cost bonus.
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

  test("activity is satisfied by positive emission share alone", () => {
    // unknown cost (+10) + active via emission share (+10).
    assert.equal(computeMinerReadiness({ total_stake_tao: 0 }, 0, 0.5), 20);
  });

  test("activity is satisfied by positive total stake alone", () => {
    // unknown cost (+10) + active via stake (+10).
    assert.equal(computeMinerReadiness({ total_stake_tao: 5 }, 0, 0), 20);
  });
});

// --- computeAlphaMarketCapTao ----------------------------------------------

describe("computeAlphaMarketCapTao", () => {
  test("multiplies finite alpha price by the total-stake supply proxy", () => {
    assert.equal(computeAlphaMarketCapTao(0.04, 1000), 40);
  });

  test("returns null when alpha price is missing", () => {
    assert.equal(computeAlphaMarketCapTao(null, 1000), null);
  });

  test("returns null when total stake is missing", () => {
    assert.equal(computeAlphaMarketCapTao(0.04, null), null);
  });

  test("returns null when both inputs are missing", () => {
    assert.equal(computeAlphaMarketCapTao(undefined, undefined), null);
  });

  test("returns null for non-finite inputs", () => {
    assert.equal(computeAlphaMarketCapTao(Number.NaN, 1000), null);
    assert.equal(
      computeAlphaMarketCapTao(0.04, Number.POSITIVE_INFINITY),
      null,
    );
  });
});

// --- computeAlphaFdvTao ------------------------------------------------------

describe("computeAlphaFdvTao", () => {
  test("multiplies finite alpha price by the fixed max supply", () => {
    assert.equal(computeAlphaFdvTao(0.04), 0.04 * ALPHA_MAX_SUPPLY);
  });

  test("returns null when alpha price is null", () => {
    assert.equal(computeAlphaFdvTao(null), null);
  });

  test("returns null when alpha price is undefined", () => {
    assert.equal(computeAlphaFdvTao(undefined), null);
  });

  test("returns null for non-finite alpha price", () => {
    assert.equal(computeAlphaFdvTao(Number.NaN), null);
    assert.equal(computeAlphaFdvTao(Number.POSITIVE_INFINITY), null);
  });
});

// --- computeNetworkValueSummary (#6641) --------------------------------------

describe("computeNetworkValueSummary", () => {
  test("empty rows yield all-zero rao-precision strings", () => {
    assert.deepEqual(computeNetworkValueSummary([]), {
      total_root_value_tao: "0.000000000",
      total_alpha_value_tao: "0.000000000",
      total_network_value_tao: "0.000000000",
    });
  });

  test("root (netuid 0) contributes total_stake_tao directly, not price-multiplied", () => {
    // Root's own alpha_market_cap_tao would be huge (price ~1.0 x its TAO
    // stake) if it were ever included in the alpha sum -- it must not be.
    const result = computeNetworkValueSummary([
      { netuid: 0, total_stake_tao: 500, alpha_market_cap_tao: 499.5 },
    ]);
    assert.deepEqual(result, {
      total_root_value_tao: "500.000000000",
      total_alpha_value_tao: "0.000000000",
      total_network_value_tao: "500.000000000",
    });
  });

  test("non-root rows sum alpha_market_cap_tao, ignoring their total_stake_tao", () => {
    const result = computeNetworkValueSummary([
      { netuid: 1, total_stake_tao: 1000, alpha_market_cap_tao: 40 },
      { netuid: 2, total_stake_tao: 2000, alpha_market_cap_tao: 60 },
    ]);
    assert.deepEqual(result, {
      total_root_value_tao: "0.000000000",
      total_alpha_value_tao: "100.000000000",
      total_network_value_tao: "100.000000000",
    });
  });

  test("root + alpha rows sum into a single network total", () => {
    const result = computeNetworkValueSummary([
      { netuid: 0, total_stake_tao: 500 },
      { netuid: 1, alpha_market_cap_tao: 40 },
      { netuid: 2, alpha_market_cap_tao: 60 },
    ]);
    assert.deepEqual(result, {
      total_root_value_tao: "500.000000000",
      total_alpha_value_tao: "100.000000000",
      total_network_value_tao: "600.000000000",
    });
  });

  test("null/non-finite values contribute zero, not NaN or a thrown error", () => {
    const result = computeNetworkValueSummary([
      { netuid: 0, total_stake_tao: null },
      { netuid: 1, alpha_market_cap_tao: null },
      { netuid: 2, alpha_market_cap_tao: Number.NaN },
    ]);
    assert.deepEqual(result, {
      total_root_value_tao: "0.000000000",
      total_alpha_value_tao: "0.000000000",
      total_network_value_tao: "0.000000000",
    });
  });
});

// --- buildEconomicsArtifact -------------------------------------------------

function econSubnet(netuid: number, overrides = {}) {
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
      total_stake_tao: "0.000000000",
      total_validators: 0,
      total_miners: 0,
      registration_open_count: 0,
      total_root_value_tao: "0.000000000",
      total_alpha_value_tao: "0.000000000",
      total_network_value_tao: "0.000000000",
    });
  });

  test("derives emission_share, open_slots, and miner_readiness for a row", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1, { block: 1_234_567 })],
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
    assert.equal(row.block, 1_234_567);
    assert.equal(row.emission_share, 1); // only priced subnet → 100% of total
    assert.equal(row.alpha_market_cap_tao, 40);
    assert.equal(row.alpha_fdv_tao, 0.04 * ALPHA_MAX_SUPPLY);
    assert.equal(row.open_slots, 47); // 256 − 9 − 200
    // 40 registration + 30 open slots + 20 cost≤1 + 10 active.
    assert.equal(row.miner_readiness, 100);
    // #7227: change fields always present; null without price history.
    assert.equal(row.alpha_price_change_1h, null);
    assert.equal(row.alpha_price_change_1d, null);
    assert.equal(row.alpha_price_change_7d, null);
    assert.equal(row.alpha_price_change_1m, null);
    assert.equal(row.netuid, 1);
    assert.equal(row.slug, "sn-1");
    assert.equal(artifact.summary.subnet_count, 1);
    assert.equal(artifact.summary.with_economics_count, 1);
    assert.equal(artifact.summary.total_stake_tao, "1000.000000000");
    assert.equal(artifact.summary.total_validators, 9);
    assert.equal(artifact.summary.total_miners, 200);
    assert.equal(artifact.summary.registration_open_count, 1);
    // No netuid-0 row -- entirely alpha value, no root value.
    assert.equal(artifact.summary.total_root_value_tao, "0.000000000");
    assert.equal(artifact.summary.total_alpha_value_tao, "40.000000000");
    assert.equal(artifact.summary.total_network_value_tao, "40.000000000");
  });

  test("root's own chain-derived alpha_market_cap_tao is excluded from the network-value alpha rollup (#6641)", () => {
    // Root (netuid 0) reports a moving_price near 1.0 on-chain even though it
    // has no AMM/alpha token (#2550) -- buildEconomicsArtifact still computes
    // a row-level alpha_market_cap_tao for it like any other row. The summary
    // rollup must carve root out by netuid, not by that row happening to have
    // no price, or root's TAO stake would double-count as alpha value too.
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(0), econSubnet(1)],
      economicsByNetuid: new Map([
        [0, { alpha_price_tao: 1.0, total_stake_tao: 500 }],
        [1, { alpha_price_tao: 0.04, total_stake_tao: 1000 }],
      ]),
      generatedAt: "2026-06-25T00:00:00.000Z",
    });
    const root = artifact.subnets.find((row: Row) => row.netuid === 0);
    // Root's own row still gets its ordinary alpha_market_cap_tao (500) --
    // untouched, only the network-value rollup treats it specially.
    assert.equal(root.alpha_market_cap_tao, 500);
    assert.equal(artifact.summary.total_root_value_tao, "500.000000000");
    assert.equal(artifact.summary.total_alpha_value_tao, "40.000000000");
    assert.equal(artifact.summary.total_network_value_tao, "540.000000000");
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
    assert.equal(artifact.subnets[0].alpha_market_cap_tao, 0.2);
    assert.equal(artifact.subnets[0].alpha_fdv_tao, 0.04 * ALPHA_MAX_SUPPLY);
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
      artifact.subnets.map((row: Row) => row.netuid),
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
      artifact.subnets.map((row: Row) => row.netuid),
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
      artifact.subnets.map((row: Row) => row.netuid),
      [1, 3, 5],
    );
    assert.deepEqual(
      artifact.subnets.map((row: Row) => row.emission_share),
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
    assert.equal(artifact.subnets[0].alpha_market_cap_tao, null);
    assert.equal(artifact.subnets[0].alpha_fdv_tao, 0);
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
    const byNetuid = new Map<number, Row>(
      artifact.subnets.map((row: Row): [number, Row] => [row.netuid, row]),
    );
    assert.equal(byNetuid.get(1)!.open_slots, null);
    assert.equal(byNetuid.get(2)!.open_slots, 0); // max(0, 10 − 17)
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

  test("attaches alpha_price_change_* from priceHistoryByNetuid (#7227)", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [econSubnet(1)],
      economicsByNetuid: new Map([[1, { alpha_price_tao: 1.5 }]]),
      generatedAt: "2026-06-25T00:00:00.000Z",
      priceHistoryByNetuid: new Map([
        [
          1,
          [
            { snapshot_date: "2026-06-20", alpha_price_tao: 1 },
            { snapshot_date: "2026-06-21", alpha_price_tao: 1.5 },
          ],
        ],
      ]),
    });
    const row = artifact.subnets[0];
    assert.equal(row.alpha_price_change_1h, null);
    assert.equal(row.alpha_price_change_1d, 50);
    assert.equal(row.alpha_price_change_7d, null);
    assert.equal(row.alpha_price_change_1m, null);
  });
});
