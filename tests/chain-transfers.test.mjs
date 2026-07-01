import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildChainTransfers,
  loadChainTransfers,
  CHAIN_TRANSFER_WINDOWS,
  DEFAULT_CHAIN_TRANSFER_WINDOW,
} from "../src/chain-transfers.mjs";

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

describe("loadChainTransfers", () => {
  test("issues totals + sender + receiver queries over the Transfer feed", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
        return [
          {
            transfer_count: 4,
            total_volume_tao: 90,
            unique_senders: 2,
            unique_receivers: 3,
          },
        ];
      }
      if (/GROUP BY hotkey/.test(sql)) return [party("5Sa", 60, 3)];
      if (/GROUP BY coldkey/.test(sql)) return [party("5Rx", 40, 2)];
      return [];
    };
    const d = await loadChainTransfers(d1, {
      windowLabel: "30d",
      observedAt: "2026-06-30T00:00:00.000Z",
      limit: 10,
    });
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /FROM account_events WHERE event_kind = \?/);
    assert.equal(calls[0].params[0], "Transfer");
    assert.match(calls[1].sql, /GROUP BY hotkey/);
    assert.equal(calls[1].params[2], 10); // limit
    assert.match(calls[2].sql, /GROUP BY coldkey/);
    assert.equal(d.total_volume_tao, 90);
    assert.equal(d.top_senders[0].address, "5Sa");
    assert.equal(d.top_receivers[0].address, "5Rx");
    assert.equal(d.observed_at, "2026-06-30T00:00:00.000Z");
  });

  test("defaults to the 7d window and computes a now-relative cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let cutoff;
    const d1 = async (sql, params) => {
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
        cutoff = params[1];
        return [{}];
      }
      return [];
    };
    const d = await loadChainTransfers(d1, {});
    assert.equal(d.window, DEFAULT_CHAIN_TRANSFER_WINDOW);
    assert.equal(cutoff, Date.now() - CHAIN_TRANSFER_WINDOWS["7d"] * 86400000);
    vi.useRealTimers();
  });

  test("an explicit windowDays (from the handler) drives the cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let cutoff;
    const d1 = async (sql, params) => {
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
        cutoff = params[1];
        return [{}];
      }
      return [];
    };
    await loadChainTransfers(d1, { windowLabel: "30d", windowDays: 30 });
    assert.equal(cutoff, Date.now() - 30 * 86400000);
    vi.useRealTimers();
  });

  test("an unknown window label falls back to the default cutoff (direct caller)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let cutoff;
    const d1 = async (sql, params) => {
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
        cutoff = params[1];
        return [{}];
      }
      return [];
    };
    await loadChainTransfers(d1, { windowLabel: "bogus" });
    assert.equal(cutoff, Date.now() - CHAIN_TRANSFER_WINDOWS["7d"] * 86400000);
    vi.useRealTimers();
  });

  test("cold store (non-array results) degrades to a zeroed card", async () => {
    const d = await loadChainTransfers(async () => null, {
      windowLabel: "7d",
    });
    assert.equal(d.transfer_count, 0);
    assert.deepEqual(d.top_senders, []);
    assert.deepEqual(d.top_receivers, []);
  });
});
