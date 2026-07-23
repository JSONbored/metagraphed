import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildChainTransferPairs } from "../src/chain-transfer-pairs.ts";

const OBSERVED_AT_MS = Date.parse("2026-07-03T00:00:00.000Z");

const pair = (
  from: string | null,
  to: string | null,
  volume: number,
  count = 1,
  lastBlock: unknown = 100,
) => ({
  from,
  to,
  volume_tao: volume,
  transfer_count: count,
  last_block: lastBlock,
  last_observed_at: OBSERVED_AT_MS,
});

describe("buildChainTransferPairs", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const opts of [{}, { totals: null, pairs: null }]) {
      const d = buildChainTransferPairs({
        window: "30d",
        ...opts,
      } as Parameters<typeof buildChainTransferPairs>[0]);
      assert.equal(d.schema_version, 1);
      assert.equal(d.window, "30d");
      assert.equal(d.sort, "volume");
      assert.equal(d.observed_at, null);
      assert.equal(d.total_volume_tao, 0);
      assert.equal(d.transfer_count, 0);
      assert.equal(d.unique_pairs, 0);
      assert.equal(d.pair_count, 0);
      assert.equal(d.top_pair_share, null);
      assert.deepEqual(d.pairs, []);
    }
  });

  test("reports the highest-volume returned pair share even when sorted by count", () => {
    const d = buildChainTransferPairs({
      window: "7d",
      sort: "count",
      observedAt: "2026-07-03T00:00:00.000Z",
      totals: {
        transfer_count: "12",
        total_volume_tao: 100,
        unique_pairs: "5",
      },
      pairs: [
        pair("5From", "5To", 20, 4.9, "8454388"),
        pair("5To", "5From", 55, 2, 8454380),
      ],
    });
    assert.equal(d.sort, "count");
    assert.equal(d.total_volume_tao, 100);
    assert.equal(d.transfer_count, 12);
    assert.equal(d.unique_pairs, 5);
    assert.equal(d.pair_count, 2);
    assert.equal(d.top_pair_share, 0.55);
    assert.equal(d.pairs[0].transfer_count, 4);
    assert.equal(d.pairs[0].last_block, 8454388);
    assert.equal(d.pairs[0].last_observed_at, "2026-07-03T00:00:00.000Z");
  });

  test("clamps a near-monopoly top-pair share below a flat 1 when other pairs exist", () => {
    // top_pair_volume_tao (full-window MAX) is 99.996% of total_volume_tao
    // (full-window SUM) but a second corridor exists — the share must not round
    // up to a flat 1 ("100% of volume") while unique_pairs/pairs[] show > 1.
    const d = buildChainTransferPairs({
      totals: {
        total_volume_tao: 250000,
        top_pair_volume_tao: 249990,
        transfer_count: 10,
        unique_pairs: 2,
      },
      pairs: [pair("5A", "5B", 249990), pair("5C", "5D", 10)],
    });
    assert.equal(d.unique_pairs, 2);
    assert.ok(d.top_pair_share! < 1, "share must be strictly below 1");
    assert.equal(d.top_pair_share, 0.9999);
  });

  test("keeps a genuine single-corridor top-pair share at exactly 1", () => {
    const d = buildChainTransferPairs({
      totals: {
        total_volume_tao: 100,
        top_pair_volume_tao: 100,
        transfer_count: 3,
        unique_pairs: 1,
      },
      pairs: [pair("5A", "5B", 100)],
    });
    assert.equal(d.top_pair_share, 1);
  });

  test("reports a zero top-pair share when totals exist but no pair rows survive", () => {
    const d = buildChainTransferPairs({
      totals: { total_volume_tao: 10, transfer_count: 1, unique_pairs: 1 },
      pairs: [pair("5A", "5A", 10)],
    });
    assert.equal(d.pair_count, 0);
    assert.equal(d.top_pair_share, 0);
  });

  test("drops malformed and self-pair rows before computing pair_count/share", () => {
    const d = buildChainTransferPairs({
      totals: { total_volume_tao: 30, transfer_count: 3, unique_pairs: 3 },
      pairs: [
        pair("5A", "5B", 10),
        pair("5A", "5A", 20),
        { from: null, to: "5B", volume_tao: 99, transfer_count: 1 },
      ],
    });
    assert.equal(d.pair_count, 1);
    assert.equal(d.top_pair_share, 0.3333);
    assert.equal(d.pairs[0].from, "5A");
  });

  test("normalizes malformed pair block and timestamp evidence to nulls", () => {
    const d = buildChainTransferPairs({
      totals: { total_volume_tao: 4, transfer_count: 4, unique_pairs: 4 },
      pairs: [
        pair("5A", "5B", 1, 1, null),
        pair("5C", "5D", 1, 1, "not-a-block"),
        {
          ...pair("5E", "5F", 1),
          last_observed_at: null,
        },
        {
          ...pair("5G", "5H", 1),
          last_observed_at: "not-a-time",
        },
        {
          ...pair("5I", "5J", 1),
          last_observed_at: 0,
        },
        {
          ...pair("5K", "5L", 1),
          last_observed_at: 8640000000000001,
        },
        pair("5M", "5N", 1, 1, ""),
        pair("5O", "5P", 1, 1, "   "),
      ],
    });
    assert.equal(d.pairs[0].last_block, null);
    assert.equal(d.pairs[1].last_block, null);
    assert.equal(d.pairs[2].last_observed_at, null);
    assert.equal(d.pairs[3].last_observed_at, null);
    assert.equal(d.pairs[4].last_observed_at, null);
    assert.equal(d.pairs[5].last_observed_at, null);
    assert.equal(d.pairs[6].last_block, null);
    assert.equal(d.pairs[7].last_block, null);
  });

  test("rounds TAO volume and normalizes unknown sort values", () => {
    const d = buildChainTransferPairs({
      sort: "bogus",
      totals: { total_volume_tao: 0.1 + 0.2 },
      pairs: [pair("5A", "5B", 0.1 + 0.2)],
    });
    assert.equal(d.sort, "volume");
    assert.equal(d.total_volume_tao, 0.3);
    assert.equal(d.pairs[0].volume_tao, 0.3);
  });

  test("clamps malformed negative aggregate volumes to the schema floor", () => {
    const d = buildChainTransferPairs({
      totals: { total_volume_tao: -1, top_pair_volume_tao: -5 },
      pairs: [pair("5A", "5B", -3)],
    });
    assert.equal(d.total_volume_tao, 0);
    assert.equal(d.top_pair_share, null);
    assert.equal(d.pairs[0].volume_tao, 0);
  });
});
