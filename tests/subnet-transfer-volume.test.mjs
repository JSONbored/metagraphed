import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildSubnetTransferVolume,
  loadSubnetTransferVolume,
  SUBNET_TRANSFER_VOLUME_WINDOWS,
  TRANSFER_KIND,
  DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW,
  SUBNET_TRANSFER_LIMIT_DEFAULT,
} from "../src/subnet-transfer-volume.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("buildSubnetTransferVolume", () => {
  test("cold / absent inputs yield schema-stable zeros + empty leaderboards", () => {
    const data = buildSubnetTransferVolume({ netuid: 7, window: "30d" });
    assert.equal(data.schema_version, 1);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.total_volume_tao, 0);
    assert.equal(data.transfer_count, 0);
    assert.equal(data.unique_senders, 0);
    assert.equal(data.unique_receivers, 0);
    assert.equal(data.top_sender_share, null);
    assert.deepEqual(data.top_senders, []);
    assert.deepEqual(data.top_receivers, []);
  });

  test("window defaults to null when omitted", () => {
    assert.equal(buildSubnetTransferVolume({ netuid: 1 }).window, null);
  });

  test("totals + leaderboards shape volume, counts, and top_sender_share", () => {
    const data = buildSubnetTransferVolume({
      netuid: 7,
      window: "7d",
      totals: {
        transfer_count: 12,
        total_volume_tao: 1000,
        unique_senders: 4,
        unique_receivers: 5,
      },
      senders: [
        { address: "5SenderA", volume_tao: 600, transfer_count: 7 },
        { address: "5SenderB", volume_tao: 200, transfer_count: 3 },
      ],
      receivers: [{ address: "5ReceiverA", volume_tao: 400, transfer_count: 4 }],
    });
    assert.equal(data.total_volume_tao, 1000);
    assert.equal(data.transfer_count, 12);
    assert.equal(data.unique_senders, 4);
    assert.equal(data.unique_receivers, 5);
    assert.equal(data.top_sender_share, 0.8);
    assert.equal(data.top_senders.length, 2);
    assert.equal(data.top_senders[0].address, "5SenderA");
    assert.equal(data.top_senders[0].volume_tao, 600);
    assert.equal(data.top_receivers[0].volume_tao, 400);
  });

  test("clamps top_sender_share to 1 when rounded party totals exceed the total", () => {
    const data = buildSubnetTransferVolume({
      netuid: 1,
      totals: { total_volume_tao: 1.0 },
      senders: [
        { address: "5A", volume_tao: 0.6, transfer_count: 1 },
        { address: "5B", volume_tao: 0.5, transfer_count: 1 },
      ],
    });
    assert.equal(data.top_sender_share, 1);
  });

  test("drops leaderboard rows with a missing address", () => {
    const data = buildSubnetTransferVolume({
      netuid: 1,
      window: "30d",
      totals: { total_volume_tao: 10, transfer_count: 1 },
      senders: [{ address: null, volume_tao: 10, transfer_count: 1 }],
      receivers: [{ address: "", volume_tao: 10, transfer_count: 1 }],
    });
    assert.deepEqual(data.top_senders, []);
    assert.deepEqual(data.top_receivers, []);
  });

  test("coerces numeric-string D1 cells and rounds TAO to rao precision", () => {
    const data = buildSubnetTransferVolume({
      netuid: 1,
      totals: {
        transfer_count: "3",
        total_volume_tao: "0.1",
        unique_senders: "2",
        unique_receivers: "2",
      },
      senders: [{ address: "5A", volume_tao: "0.1", transfer_count: "1" }],
    });
    assert.equal(data.transfer_count, 3);
    assert.equal(data.total_volume_tao, 0.1);
    assert.equal(data.top_senders[0].volume_tao, 0.1);
  });

  test("top_sender_share is null when total volume is zero", () => {
    const data = buildSubnetTransferVolume({
      netuid: 1,
      senders: [{ address: "5A", volume_tao: 5, transfer_count: 1 }],
    });
    assert.equal(data.top_sender_share, null);
  });
});

describe("loadSubnetTransferVolume", () => {
  test("attributes Transfer rows via the neurons snapshot, not a netuid column", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
        return [
          {
            transfer_count: 5,
            total_volume_tao: 250,
            unique_senders: 2,
            unique_receivers: 3,
            last_observed: 1717900000000,
          },
        ];
      }
      if (/GROUP BY hotkey/.test(sql)) {
        return [{ address: "5Sender", volume_tao: 200, transfer_count: 4 }];
      }
      if (/GROUP BY coldkey/.test(sql)) {
        return [{ address: "5Receiver", volume_tao: 150, transfer_count: 3 }];
      }
      return [];
    };
    const { data, generatedAt } = await loadSubnetTransferVolume(d1, 7, {
      windowLabel: "30d",
      limit: 10,
    });
    assert.equal(calls.length, 3);
    for (const { sql, params } of calls) {
      assert.match(sql, /FROM account_events/);
      assert.match(sql, /FROM neurons WHERE netuid = \?/);
      assert.equal(params[0], TRANSFER_KIND);
      assert.equal(params[1], Date.now() - 30 * DAY_MS);
      assert.ok(params.includes(7));
    }
    assert.doesNotMatch(calls[0].sql, /netuid = \? AND event_kind/);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.total_volume_tao, 250);
    assert.equal(data.top_senders[0].address, "5Sender");
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
    vi.useRealTimers();
  });

  test("defaults to the 30d window and limit when none is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) return [{}];
      return [];
    };
    const { data } = await loadSubnetTransferVolume(d1, 1, {});
    assert.equal(data.window, DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW);
    assert.equal(
      calls[0].params[1],
      Date.now() - SUBNET_TRANSFER_VOLUME_WINDOWS["30d"] * DAY_MS,
    );
    assert.equal(calls[1].params[3], SUBNET_TRANSFER_LIMIT_DEFAULT);
    vi.useRealTimers();
  });

  test("cold D1 yields zeroed totals and a null generated_at", async () => {
    const d1 = async () => [];
    const { data, generatedAt } = await loadSubnetTransferVolume(d1, 99, {
      windowLabel: "7d",
    });
    assert.equal(data.total_volume_tao, 0);
    assert.equal(data.transfer_count, 0);
    assert.equal(data.window, "7d");
    assert.equal(generatedAt, null);
  });

  test("a null MAX(observed_at) leaves generated_at null (not epoch zero)", async () => {
    const d1 = async (sql) => {
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) {
        return [
          {
            transfer_count: 0,
            total_volume_tao: 0,
            unique_senders: 0,
            unique_receivers: 0,
            last_observed: null,
          },
        ];
      }
      return [];
    };
    const { generatedAt } = await loadSubnetTransferVolume(d1, 7, {});
    assert.equal(generatedAt, null);
  });

  test("an unknown window label is normalized to the default in the artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    let captured;
    const d1 = async (sql, params) => {
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) captured = params;
      return [];
    };
    const { data } = await loadSubnetTransferVolume(d1, 7, {
      windowLabel: "bogus",
    });
    assert.equal(data.window, DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW);
    assert.equal(
      captured[1],
      Date.now() - SUBNET_TRANSFER_VOLUME_WINDOWS["30d"] * DAY_MS,
    );
    vi.useRealTimers();
  });

  test("coerces and caps a fractional direct-call limit before binding LIMIT", async () => {
    const limits = [];
    const d1 = async (sql, params) => {
      if (/GROUP BY hotkey/.test(sql) || /GROUP BY coldkey/.test(sql)) {
        limits.push(params.at(-1));
      }
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) return [{}];
      return [];
    };
    await loadSubnetTransferVolume(d1, 7, { limit: 12.9 });
    assert.deepEqual(limits, [12, 12]);
  });

  test("caps the leaderboard limit at 100 and falls back on NaN", async () => {
    const limits = [];
    const d1 = async (sql, params) => {
      if (/GROUP BY hotkey/.test(sql) || /GROUP BY coldkey/.test(sql)) {
        limits.push(params.at(-1));
      }
      if (/COUNT\(DISTINCT hotkey\)/.test(sql)) return [{}];
      return [];
    };
    await loadSubnetTransferVolume(d1, 7, { limit: 500 });
    assert.deepEqual(limits, [100, 100]);
    await loadSubnetTransferVolume(d1, 7, { limit: "nope" });
    assert.deepEqual(limits, [100, 100, 20, 20]);
  });
});
