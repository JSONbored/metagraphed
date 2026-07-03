import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildChainTransferPairs,
  loadChainTransferPairs,
  CHAIN_TRANSFER_PAIR_WINDOWS,
  CHAIN_TRANSFER_PAIR_LIMIT_MAX,
  DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW,
} from "../src/chain-transfer-pairs.mjs";

const OBSERVED_AT_MS = Date.parse("2026-07-03T00:00:00.000Z");

const pair = (from, to, volume, count = 1, lastBlock = 100) => ({
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
      const d = buildChainTransferPairs({ window: "30d", ...opts });
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
      ],
    });
    assert.equal(d.pairs[0].last_block, null);
    assert.equal(d.pairs[1].last_block, null);
    assert.equal(d.pairs[2].last_observed_at, null);
    assert.equal(d.pairs[3].last_observed_at, null);
    assert.equal(d.pairs[4].last_observed_at, null);
    assert.equal(d.pairs[5].last_observed_at, null);
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

describe("loadChainTransferPairs", () => {
  test("uses full-window top volume and SQL-safe pair aliases", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/WITH pair_totals/.test(sql)) {
        return [
          {
            transfer_count: 10,
            total_volume_tao: 100,
            unique_pairs: 2,
            top_pair_volume_tao: 80,
          },
        ];
      }
      if (/ORDER BY/.test(sql)) {
        return [
          {
            from_address: "5A",
            to_address: "5B",
            volume_tao: 20,
            transfer_count: 5,
            last_block: "8454388",
            last_observed_at: OBSERVED_AT_MS,
          },
        ];
      }
      return [];
    };
    const d = await loadChainTransferPairs(d1, {
      windowLabel: "30d",
      observedAt: "2026-07-03T00:00:00.000Z",
      limit: 1,
      sort: "count",
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /FROM account_events WHERE event_kind = \?/);
    assert.match(calls[0].sql, /hotkey <> coldkey/);
    assert.match(calls[0].sql, /amount_tao IS NOT NULL AND amount_tao >= 0/);
    assert.equal(calls[0].params[0], "Transfer");
    assert.match(calls[1].sql, /hotkey AS from_address/);
    assert.match(calls[1].sql, /coldkey AS to_address/);
    assert.doesNotMatch(calls[1].sql, /\bAS\s+from\b/i);
    assert.doesNotMatch(calls[1].sql, /\bAS\s+to\b/i);
    assert.match(calls[1].sql, /ORDER BY transfer_count DESC, volume_tao DESC/);
    assert.equal(calls[1].params.at(-1), 1);
    assert.equal(d.total_volume_tao, 100);
    assert.equal(d.unique_pairs, 2);
    assert.equal(d.top_pair_share, 0.8);
    assert.equal(d.pairs[0].volume_tao, 20);
    assert.equal(d.pairs[0].from, "5A");
    assert.equal(d.pairs[0].to, "5B");
    assert.equal(d.observed_at, "2026-07-03T00:00:00.000Z");
  });

  test("defaults to the 7d window and computes a now-relative cutoff", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
      let cutoff;
      const d1 = async (sql, params) => {
        if (/WITH pair_totals/.test(sql)) {
          cutoff = params[1];
          return [{}];
        }
        return [];
      };
      const d = await loadChainTransferPairs(d1, {});
      assert.equal(d.window, DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW);
      assert.equal(
        cutoff,
        Date.now() - CHAIN_TRANSFER_PAIR_WINDOWS["7d"] * 86400000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("unknown direct-call window labels fall back to the default cutoff", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
      let cutoff;
      const d1 = async (sql, params) => {
        if (/WITH pair_totals/.test(sql)) {
          cutoff = params[1];
          return [{}];
        }
        return [];
      };
      const d = await loadChainTransferPairs(d1, { windowLabel: "bogus" });
      assert.equal(
        cutoff,
        Date.now() - CHAIN_TRANSFER_PAIR_WINDOWS["7d"] * 86400000,
      );
      assert.equal(d.window, DEFAULT_CHAIN_TRANSFER_PAIR_WINDOW);
    } finally {
      vi.useRealTimers();
    }
  });

  test("explicit windowDays and unknown direct-call sort fall back safely", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
      let cutoff;
      let orderSql = "";
      const d1 = async (sql, params) => {
        if (/WITH pair_totals/.test(sql)) {
          cutoff = params[1];
          return [{}];
        }
        if (/ORDER BY/.test(sql)) orderSql = sql;
        return [];
      };
      const d = await loadChainTransferPairs(d1, {
        windowLabel: "30d",
        windowDays: 30,
        sort: "bogus",
      });
      assert.equal(cutoff, Date.now() - 30 * 86400000);
      assert.equal(d.sort, "volume");
      assert.match(orderSql, /ORDER BY volume_tao DESC, transfer_count DESC/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("direct callers cannot build a non-positive cutoff window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-03T00:00:00.000Z"));
      const cutoffs = [];
      const d1 = async (sql, params) => {
        if (/WITH pair_totals/.test(sql)) {
          cutoffs.push(params[1]);
          return [{}];
        }
        return [];
      };
      await loadChainTransferPairs(d1, { windowDays: 0 });
      await loadChainTransferPairs(d1, { windowDays: -7 });
      assert.deepEqual(cutoffs, [Date.now() - 86400000, Date.now() - 86400000]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("direct callers cannot bind an oversized or empty limit", async () => {
    const boundLimits = [];
    const d1 = async (sql, params) => {
      if (/ORDER BY/.test(sql)) {
        boundLimits.push(params.at(-1));
      }
      return [];
    };
    await loadChainTransferPairs(d1, { limit: 500 });
    await loadChainTransferPairs(d1, { limit: 0 });
    assert.deepEqual(boundLimits, [CHAIN_TRANSFER_PAIR_LIMIT_MAX, 1]);
  });

  test("cold store (non-array results) degrades to a zeroed card", async () => {
    const d = await loadChainTransferPairs(async () => null, {
      windowLabel: "7d",
    });
    assert.equal(d.transfer_count, 0);
    assert.deepEqual(d.pairs, []);
  });
});
