import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ALPHA_PRICE_CHANGE_FIELDS,
  attachAlphaPriceChanges,
  computeAlphaPriceChanges,
  emptyAlphaPriceChanges,
  enrichEconomicsBlob,
  indexPriceHistoryByNetuid,
  normalizePricePoints,
  pctChange,
  pointAtOrBefore,
} from "../src/alpha-price-change.mjs";
import { buildEconomicsArtifact } from "../scripts/lib/economics-artifacts.mjs";

describe("alpha-price-change — pctChange", () => {
  test("rounds to 2dp and handles gain/loss", () => {
    assert.equal(pctChange(100, 110), 10);
    assert.equal(pctChange(100, 90), -10);
    assert.equal(pctChange(1, 1.005), 0.5);
  });

  test("null when start is 0 or either side non-finite", () => {
    assert.equal(pctChange(0, 10), null);
    assert.equal(pctChange(null, 10), null);
    assert.equal(pctChange(10, NaN), null);
  });
});

describe("alpha-price-change — pointAtOrBefore / normalize", () => {
  test("picks the latest point on or before the lookback target", () => {
    const points = normalizePricePoints([
      { snapshot_date: "2026-07-01", alpha_price_tao: 1 },
      { snapshot_date: "2026-07-05", alpha_price_tao: 2 },
      { snapshot_date: "2026-07-10", alpha_price_tao: 3 },
    ]);
    assert.equal(pointAtOrBefore(points, "2026-07-10", 5)?.date, "2026-07-05");
    // 1d lookback from 07-10 targets 07-09 — latest point on or before that is 07-05
    assert.equal(pointAtOrBefore(points, "2026-07-10", 1)?.date, "2026-07-05");
    assert.equal(pointAtOrBefore(points, "2026-07-10", 9)?.date, "2026-07-01");
    assert.equal(pointAtOrBefore(points, "2026-07-10", 30), null);
  });

  test("drops unusable rows", () => {
    assert.deepEqual(
      normalizePricePoints([
        { snapshot_date: "2026-07-01", alpha_price_tao: null },
        { snapshot_date: "bad", alpha_price_tao: 1 },
        { snapshot_date: "2026-07-02", alpha_price_tao: "1.5" },
      ]),
      [{ date: "2026-07-02", alpha_price_tao: 1.5 }],
    );
  });
});

describe("alpha-price-change — computeAlphaPriceChanges", () => {
  const rows = [
    { snapshot_date: "2026-06-10", alpha_price_tao: 1.0 },
    { snapshot_date: "2026-07-03", alpha_price_tao: 1.5 },
    { snapshot_date: "2026-07-09", alpha_price_tao: 2.0 },
    { snapshot_date: "2026-07-10", alpha_price_tao: 2.2 },
  ];

  test("computes 1d/7d/1m from live price vs snapshot lookback", () => {
    const out = computeAlphaPriceChanges({
      currentPrice: 2.2,
      rows,
      asOfDate: "2026-07-10",
    });
    assert.equal(out.alpha_price_change_1h, null); // daily snapshots
    assert.equal(out.alpha_price_change_1d, pctChange(2.0, 2.2));
    assert.equal(out.alpha_price_change_7d, pctChange(1.5, 2.2));
    assert.equal(out.alpha_price_change_1m, pctChange(1.0, 2.2));
  });

  test("null windows when history is insufficient", () => {
    const out = computeAlphaPriceChanges({
      currentPrice: 2,
      rows: [{ snapshot_date: "2026-07-10", alpha_price_tao: 2 }],
      asOfDate: "2026-07-10",
    });
    assert.deepEqual(out, emptyAlphaPriceChanges());
  });

  test("null everything when current price is missing", () => {
    assert.deepEqual(
      computeAlphaPriceChanges({ currentPrice: null, rows }),
      emptyAlphaPriceChanges(),
    );
  });
});

describe("alpha-price-change — attach / enrich / index", () => {
  test("attachAlphaPriceChanges merges fields onto rows", () => {
    const history = indexPriceHistoryByNetuid([
      { netuid: 7, snapshot_date: "2026-07-01", alpha_price_tao: 1 },
      { netuid: 7, snapshot_date: "2026-07-10", alpha_price_tao: 2 },
    ]);
    const [row] = attachAlphaPriceChanges(
      [{ netuid: 7, alpha_price_tao: 2 }],
      history,
    );
    assert.equal(row.alpha_price_change_1d, 100);
    assert.equal(row.alpha_price_change_1h, null);
    for (const field of ALPHA_PRICE_CHANGE_FIELDS) {
      assert.ok(Object.hasOwn(row, field));
    }
  });

  test("attachAlphaPriceChanges accepts plain-object history keyed by string netuid", () => {
    const [row] = attachAlphaPriceChanges([{ netuid: 3, alpha_price_tao: 2 }], {
      3: [
        { snapshot_date: "2026-07-01", alpha_price_tao: 1 },
        { snapshot_date: "2026-07-10", alpha_price_tao: 2 },
      ],
    });
    assert.equal(row.alpha_price_change_1d, 100);
  });

  test("attachAlphaPriceChanges accepts history.points shape and skips non-objects", () => {
    const out = attachAlphaPriceChanges(
      [null, { netuid: 1, alpha_price_tao: 4 }],
      {
        1: {
          points: [
            { date: "2026-07-01", alpha_price_tao: 2 },
            { date: "2026-07-10", alpha_price_tao: 4 },
          ],
        },
      },
    );
    assert.equal(out[0], null);
    assert.equal(out[1].alpha_price_change_1d, 100);
  });

  test("attachAlphaPriceChanges returns non-arrays unchanged", () => {
    assert.equal(attachAlphaPriceChanges(null, null), null);
  });

  test("enrichEconomicsBlob with no history still stamps null fields", () => {
    const blob = enrichEconomicsBlob(
      { subnets: [{ netuid: 1, alpha_price_tao: 1 }] },
      null,
    );
    assert.deepEqual(blob.subnets[0].alpha_price_change_1d, null);
    assert.equal(blob.subnets[0].alpha_price_change_7d, null);
  });

  test("enrichEconomicsBlob no-ops on non-objects and blobs without subnets", () => {
    assert.equal(enrichEconomicsBlob(null, null), null);
    assert.deepEqual(enrichEconomicsBlob([1], null), [1]);
    assert.deepEqual(enrichEconomicsBlob({ summary: {} }, null), {
      summary: {},
    });
  });

  test("indexPriceHistoryByNetuid skips invalid netuids and blank prices", () => {
    const map = indexPriceHistoryByNetuid([
      { netuid: -1, snapshot_date: "2026-07-01", alpha_price_tao: 1 },
      { netuid: 1, snapshot_date: "2026-07-01", alpha_price_tao: "" },
      { netuid: 1, date: "2026-07-02", alpha_price_tao: 1.25 },
      null,
    ]);
    assert.equal(map.size, 1);
    assert.equal(map.get(1)[0].alpha_price_tao, 1.25);
  });

  test("normalizePricePoints tolerates empty-string numeric prices as null", () => {
    assert.deepEqual(
      normalizePricePoints([
        { snapshot_date: "2026-07-01", alpha_price_tao: " " },
      ]),
      [],
    );
  });

  test("normalizePricePoints covers date fallback and non-array input", () => {
    assert.deepEqual(normalizePricePoints(null), []);
    assert.deepEqual(
      normalizePricePoints([
        { date: "2026-07-03", alpha_price_tao: Infinity },
        { date: "2026-07-04", alpha_price_tao: 3 },
        { snapshot_date: null, date: null, alpha_price_tao: 9 },
      ]),
      [{ date: "2026-07-04", alpha_price_tao: 3 }],
    );
  });

  test("computeAlphaPriceChanges defaults asOfDate from latest point", () => {
    const out = computeAlphaPriceChanges({
      currentPrice: 2,
      points: [
        { date: "2026-07-01", alpha_price_tao: 1 },
        { date: "2026-07-10", alpha_price_tao: 2 },
      ],
    });
    assert.equal(out.alpha_price_change_1d, 100);
  });

  test("computeAlphaPriceChanges uses UTC today when series is empty", () => {
    const out = computeAlphaPriceChanges({
      currentPrice: 2,
      points: [],
    });
    assert.deepEqual(out, emptyAlphaPriceChanges());
  });

  test("pointAtOrBefore tolerates partial ISO dates via shiftDate defaults", () => {
    const points = [{ date: "2025-12-01", alpha_price_tao: 1 }];
    assert.equal(pointAtOrBefore(points, "2026", 1)?.date, "2025-12-01");
  });

  test("attachAlphaPriceChanges treats null history entries as missing", () => {
    const [row] = attachAlphaPriceChanges([{ netuid: 9, alpha_price_tao: 2 }], {
      9: null,
    });
    assert.equal(row.alpha_price_change_1d, null);
  });

  test("indexPriceHistoryByNetuid accepts non-array input", () => {
    assert.equal(indexPriceHistoryByNetuid(null).size, 0);
  });
});

describe("buildEconomicsArtifact — alpha price change fields", () => {
  test("always emits the four fields (null without history)", () => {
    const artifact = buildEconomicsArtifact({
      subnets: [{ netuid: 1, slug: "a", name: "A" }],
      economicsByNetuid: new Map([
        [
          1,
          {
            max_uids: 64,
            validator_count: 1,
            max_validators: 64,
            miner_count: 0,
            registration_allowed: true,
            registration_cost_tao: 1,
            alpha_price_tao: 0.5,
            total_stake_tao: 100,
            max_stake_tao: null,
            tao_in_pool_tao: null,
            alpha_in_pool: null,
            alpha_out_pool: null,
            subnet_volume_tao: null,
            owner_hotkey: null,
            owner_coldkey: null,
          },
        ],
      ]),
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
    const row = artifact.subnets[0];
    for (const field of ALPHA_PRICE_CHANGE_FIELDS) {
      assert.equal(row[field], null);
    }
  });

  test("fills change fields when priceHistoryByNetuid is provided", () => {
    const history = new Map([
      [
        1,
        [
          { snapshot_date: "2026-07-01", alpha_price_tao: 0.25 },
          { snapshot_date: "2026-07-10", alpha_price_tao: 0.5 },
        ],
      ],
    ]);
    const artifact = buildEconomicsArtifact({
      subnets: [{ netuid: 1, slug: "a", name: "A" }],
      economicsByNetuid: new Map([
        [
          1,
          {
            max_uids: 64,
            validator_count: 1,
            max_validators: 64,
            miner_count: 0,
            registration_allowed: true,
            registration_cost_tao: 1,
            alpha_price_tao: 0.5,
            total_stake_tao: 100,
            max_stake_tao: null,
            tao_in_pool_tao: null,
            alpha_in_pool: null,
            alpha_out_pool: null,
            subnet_volume_tao: null,
            owner_hotkey: null,
            owner_coldkey: null,
          },
        ],
      ]),
      generatedAt: "2026-07-10T00:00:00.000Z",
      priceHistoryByNetuid: history,
    });
    assert.equal(artifact.subnets[0].alpha_price_change_1d, 100);
    assert.equal(artifact.subnets[0].alpha_price_change_1h, null);
  });
});
