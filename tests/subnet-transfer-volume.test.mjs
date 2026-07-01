import assert from "node:assert/strict";
import { describe, test } from "vitest";
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
      receivers: [
        { address: "5ReceiverA", volume_tao: 400, transfer_count: 4 },
      ],
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

  test("non-array party rows collapse to empty leaderboards", () => {
    const data = buildSubnetTransferVolume({
      netuid: 1,
      senders: "bad",
      receivers: 42,
    });
    assert.deepEqual(data.top_senders, []);
    assert.deepEqual(data.top_receivers, []);
  });
});

describe("loadSubnetTransferVolume", () => {
  test("attributes Transfer rows via the neurons snapshot, not a netuid column", async () => {
    const nowMs = Date.parse("2026-06-30T00:00:00.000Z");
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) {
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
      nowMs,
    });
    assert.equal(calls.length, 3);
    for (const { sql, params } of calls) {
      assert.match(
        sql,
        /FROM account_events INDEXED BY idx_account_events_kind_observed/,
      );
      assert.match(sql, /FROM neurons WHERE netuid = \?/);
      assert.ok(params.includes(7));
      assert.ok(params.includes(TRANSFER_KIND));
      assert.ok(params.includes(nowMs - 30 * DAY_MS));
    }
    assert.doesNotMatch(calls[0].sql, /netuid = \? AND event_kind/);
    assert.equal(data.netuid, 7);
    assert.equal(data.window, "30d");
    assert.equal(data.total_volume_tao, 250);
    assert.equal(data.top_senders[0].address, "5Sender");
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
  });

  test("top_receivers ranks only registered subnet hotkeys, not external counterparties", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) {
        return [
          {
            transfer_count: 2,
            total_volume_tao: 100,
            unique_senders: 1,
            unique_receivers: 1,
          },
        ];
      }
      if (/GROUP BY hotkey/.test(sql)) {
        return [
          { address: "5SubnetSender", volume_tao: 100, transfer_count: 2 },
        ];
      }
      if (/GROUP BY coldkey/.test(sql)) {
        return [
          { address: "5SubnetReceiver", volume_tao: 40, transfer_count: 1 },
        ];
      }
      return [];
    };
    const { data } = await loadSubnetTransferVolume(d1, 7, { limit: 5 });
    const receivers = calls.find((c) => /GROUP BY coldkey/.test(c.sql));
    assert.ok(receivers);
    assert.match(
      receivers.sql,
      /coldkey IN \(SELECT hotkey FROM neurons WHERE netuid = \? AND hotkey IS NOT NULL\)/,
    );
    assert.doesNotMatch(
      receivers.sql,
      /OR coldkey IN \(SELECT hotkey FROM neurons/,
    );
    assert.equal(receivers.params[0], TRANSFER_KIND);
    assert.equal(receivers.params[2], 7);
    assert.equal(receivers.params[3], 5);
    assert.equal(data.top_receivers[0].address, "5SubnetReceiver");
  });

  test("defaults to the 30d window and limit when none is given", async () => {
    const nowMs = Date.parse("2026-06-30T00:00:00.000Z");
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) return [{}];
      return [];
    };
    const { data } = await loadSubnetTransferVolume(d1, 1, { nowMs });
    assert.equal(data.window, DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW);
    assert.equal(
      calls[0].params[3],
      nowMs - SUBNET_TRANSFER_VOLUME_WINDOWS["30d"] * DAY_MS,
    );
    assert.equal(calls[1].params[3], SUBNET_TRANSFER_LIMIT_DEFAULT);
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
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) {
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

  test("rejects empty-string and non-finite last_observed timestamps", async () => {
    for (const last_observed of ["", "not-a-number"]) {
      const d1 = async (sql) => {
        if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) {
          return [{ last_observed }];
        }
        return [];
      };
      const { generatedAt } = await loadSubnetTransferVolume(d1, 7, {});
      assert.equal(generatedAt, null, String(last_observed));
    }
  });

  test("coerces a numeric-string last_observed through the string branch", async () => {
    const d1 = async (sql) => {
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) {
        return [{ last_observed: "1717900000000" }];
      }
      return [];
    };
    const { generatedAt } = await loadSubnetTransferVolume(d1, 7, {});
    assert.equal(generatedAt, new Date(1717900000000).toISOString());
  });

  test("non-array D1 payloads degrade safely", async () => {
    const d1 = async (sql) => {
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) return null;
      if (/GROUP BY hotkey/.test(sql)) return null;
      if (/GROUP BY coldkey/.test(sql)) return undefined;
      return null;
    };
    const { data, generatedAt } = await loadSubnetTransferVolume(d1, 7, {});
    assert.equal(data.total_volume_tao, 0);
    assert.deepEqual(data.top_senders, []);
    assert.deepEqual(data.top_receivers, []);
    assert.equal(generatedAt, null);
  });

  test("resolveLimit uses the numeric typeof branch", async () => {
    let cap;
    const d1 = async (sql, params) => {
      if (/GROUP BY hotkey/.test(sql)) cap = params.at(-1);
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) return [{}];
      return [];
    };
    await loadSubnetTransferVolume(d1, 7, { limit: 15 });
    assert.equal(cap, 15);
  });

  test("resolveWindowLabel keeps a supported window label", async () => {
    const d1 = async (sql) => {
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) return [{}];
      return [];
    };
    const { data } = await loadSubnetTransferVolume(d1, 7, {
      windowLabel: "7d",
    });
    assert.equal(data.window, "7d");
  });

  test("an unknown window label is normalized to the default in the artifact", async () => {
    const nowMs = Date.parse("2026-06-30T00:00:00.000Z");
    let captured;
    const d1 = async (sql, params) => {
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) captured = params;
      return [];
    };
    const { data } = await loadSubnetTransferVolume(d1, 7, {
      windowLabel: "bogus",
      nowMs,
    });
    assert.equal(data.window, DEFAULT_SUBNET_TRANSFER_VOLUME_WINDOW);
    assert.equal(
      captured[3],
      nowMs - SUBNET_TRANSFER_VOLUME_WINDOWS["30d"] * DAY_MS,
    );
  });

  test("nowMs controls the window cutoff for deterministic boundary tests", async () => {
    const nowMs = 1_700_000_000_000;
    let cutoff;
    const d1 = async (sql, params) => {
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) cutoff = params[3];
      return [];
    };
    await loadSubnetTransferVolume(d1, 7, { windowLabel: "7d", nowMs });
    assert.equal(cutoff, nowMs - 7 * DAY_MS);
  });

  test("coerces and caps a fractional direct-call limit before binding LIMIT", async () => {
    const limits = [];
    const d1 = async (sql, params) => {
      if (/GROUP BY hotkey/.test(sql) || /GROUP BY coldkey/.test(sql)) {
        limits.push(params.at(-1));
      }
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) return [{}];
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
      if (/COUNT\(DISTINCT CASE WHEN coldkey IN/.test(sql)) return [{}];
      return [];
    };
    await loadSubnetTransferVolume(d1, 7, { limit: 500 });
    assert.deepEqual(limits, [100, 100]);
    await loadSubnetTransferVolume(d1, 7, { limit: "nope" });
    assert.deepEqual(limits, [100, 100, 20, 20]);
  });
});
