import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildChainTransfers } from "../src/chain-transfers.ts";

const party = (address, volume, count = 1) => ({
  address,
  volume_tao: volume,
  transfer_count: count,
});

describe("buildChainTransfers", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const opts of [{}, { totals: null, senders: null, receivers: null }]) {
      const d = buildChainTransfers({ window: "30d", ...opts });
      assert.equal(d.schema_version, 1);
      assert.equal(d.window, "30d");
      assert.equal(d.observed_at, null);
      assert.equal(d.total_volume_tao, 0);
      assert.equal(d.transfer_count, 0);
      assert.equal(d.unique_senders, 0);
      assert.equal(d.unique_receivers, 0);
      assert.equal(d.top_sender_share, null);
      assert.deepEqual(d.top_senders, []);
      assert.deepEqual(d.top_receivers, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildChainTransfers({}).window, null);
  });

  test("shapes totals + ranked sender/receiver leaderboards", () => {
    const d = buildChainTransfers({
      window: "30d",
      observedAt: "2026-06-30T00:00:00.000Z",
      totals: {
        transfer_count: 12,
        total_volume_tao: 100,
        unique_senders: 5,
        unique_receivers: 7,
      },
      senders: [party("5Sa", 60, 3), party("5Sb", 20, 2)],
      receivers: [party("5Rx", 55, 4)],
    });
    assert.equal(d.total_volume_tao, 100);
    assert.equal(d.transfer_count, 12);
    assert.equal(d.unique_senders, 5);
    assert.equal(d.unique_receivers, 7);
    assert.equal(d.observed_at, "2026-06-30T00:00:00.000Z");
    assert.equal(d.top_senders[0].address, "5Sa");
    assert.equal(d.top_senders[0].volume_tao, 60);
    assert.equal(d.top_receivers[0].address, "5Rx");
  });

  test("top_sender_share is the fetched senders' share of total volume", () => {
    const d = buildChainTransfers({
      totals: { total_volume_tao: 100 },
      senders: [party("5Sa", 60), party("5Sb", 20)], // 80 / 100
    });
    assert.equal(d.top_sender_share, 0.8);
  });

  test("clamps a near-monopoly top_sender_share below a flat 1 when other senders exist", () => {
    // The top senders moved 249990 of 250000 TAO (99.996%); the remaining 10 TAO
    // came from senders outside the top-N leaderboard (unique_senders is 3). At 4dp
    // 249990/250000 rounds to 1.0000 without the clamp — which would report the top
    // senders as 100% of outflow while other accounts still sent TAO.
    const d = buildChainTransfers({
      totals: { total_volume_tao: 250000, unique_senders: 3 },
      senders: [party("5Sa", 249990)],
    });
    assert.ok(d.top_sender_share < 1, "near-total share must stay below 1");
    assert.equal(d.top_sender_share, 0.9999);
  });

  test("keeps an exact 1 top_sender_share when the top senders are the whole volume", () => {
    const d = buildChainTransfers({
      totals: { total_volume_tao: 100, unique_senders: 2 },
      senders: [party("5Sa", 60), party("5Sb", 40)], // 100 / 100
    });
    assert.equal(d.top_sender_share, 1);
  });

  test("keeps exact decimal full-volume top_sender_share at 1 despite float underflow", () => {
    const d = buildChainTransfers({
      totals: { total_volume_tao: 0.8, unique_senders: 2 },
      senders: [party("5Sa", 0.1), party("5Sb", 0.7)], // JS sum is 0.7999999999999999
    });
    assert.equal(d.top_sender_share, 1);
  });

  test("top_sender_share is null when there is no volume", () => {
    const d = buildChainTransfers({
      totals: { total_volume_tao: 0 },
      senders: [],
    });
    assert.equal(d.top_sender_share, null);
  });

  test("drops rows with a missing address and truncates fractional counts", () => {
    const d = buildChainTransfers({
      totals: { total_volume_tao: 30 },
      senders: [
        party("5Sa", 30, 2.9),
        { address: null, volume_tao: 99, transfer_count: 1 },
        { volume_tao: 5, transfer_count: 1 },
      ],
    });
    assert.equal(d.top_senders.length, 1);
    assert.equal(d.top_senders[0].transfer_count, 2); // truncated
  });

  test("rounds tao volume to rao precision", () => {
    const d = buildChainTransfers({
      totals: { total_volume_tao: 0.1 + 0.2 }, // 0.30000000000000004
      senders: [],
    });
    assert.equal(d.total_volume_tao, 0.3);
  });
});
