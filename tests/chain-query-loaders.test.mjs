import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadChainSigners,
  loadChainFees,
} from "../src/chain-query-loaders.mjs";

describe("loadChainSigners", () => {
  test("builds a ranked leaderboard from extrinsic rows", async () => {
    const calls = [];
    const d1Runner = async (sql, params) => {
      calls.push({ sql, params });
      return [
        {
          signer: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
          tx_count: 8,
          total_fee_tao: 2,
          total_tip_tao: 0.5,
          last_tx_block: 100,
        },
      ];
    };
    const { data, rows } = await loadChainSigners(d1Runner, {
      windowLabel: "30d",
      windowDays: 30,
      observedAt: "2026-06-01T00:00:00.000Z",
      limit: 10,
      callModule: "Balances",
    });
    assert.equal(rows.length, 1);
    assert.equal(data.window, "30d");
    assert.equal(data.signer_count, 1);
    assert.equal(data.signers[0].tx_count, 8);
    assert.match(calls[0].sql, /call_module = \?/);
    assert.equal(calls[0].params[1], "Balances");
    assert.equal(calls[0].params[2], 10);
  });

  test("omits the module clause when callModule is null", async () => {
    let sql = "";
    let params;
    await loadChainSigners(
      async (query, bound) => {
        sql = query;
        params = bound;
        return [];
      },
      { windowLabel: "7d", windowDays: 7, limit: 5 },
    );
    assert.doesNotMatch(sql, /call_module/);
    assert.equal(params.length, 2);
    assert.equal(params[1], 5);
    assert.equal(typeof params[0], "number");
  });

  test("orders equal tx_count rows by signer ASC in SQL", async () => {
    let sql = "";
    await loadChainSigners(
      async (query) => {
        sql = query;
        return [];
      },
      { windowLabel: "7d", windowDays: 7, limit: 5 },
    );
    assert.match(sql, /ORDER BY tx_count DESC, signer ASC/);
  });
});

describe("loadChainFees", () => {
  test("builds daily series and top payers from extrinsic rows", async () => {
    const calls = [];
    const d1Runner = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY day/.test(sql)) {
        return [
          {
            day: "2026-06-29",
            extrinsic_count: 10,
            total_fee_tao: 5,
            total_tip_tao: 1,
          },
        ];
      }
      return [
        {
          signer: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
          total_fee_tao: 3,
          total_tip_tao: 0.5,
          extrinsic_count: 4,
        },
      ];
    };
    const { data, dailyRows, payerRows } = await loadChainFees(d1Runner, {
      windowLabel: "7d",
      windowDays: 7,
      observedAt: "2026-06-30T00:00:00.000Z",
      limit: 5,
      callModule: "Balances",
    });
    assert.equal(dailyRows.length, 1);
    assert.equal(payerRows.length, 1);
    assert.equal(data.window, "7d");
    assert.equal(data.day_count, 1);
    assert.equal(data.daily[0].avg_fee_tao, 0.5);
    assert.equal(data.top_fee_payers[0].total_fee_tao, 3);
    assert.match(calls[0].sql, /GROUP BY day/);
    assert.match(calls[1].sql, /ORDER BY total_fee_tao DESC/);
    assert.equal(calls[1].params[2], 5);
  });

  test("omits the module clause when callModule is null", async () => {
    const sqls = [];
    await loadChainFees(
      async (sql) => {
        sqls.push(sql);
        return [];
      },
      { windowLabel: "30d", windowDays: 30, limit: 10 },
    );
    for (const sql of sqls) {
      assert.doesNotMatch(sql, /call_module/);
    }
  });
});
