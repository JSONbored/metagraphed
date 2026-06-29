import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadChainSigners } from "../src/chain-query-loaders.mjs";

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
    await loadChainSigners(
      async (query) => {
        sql = query;
        return [];
      },
      { windowLabel: "7d", windowDays: 7, limit: 5 },
    );
    assert.doesNotMatch(sql, /call_module/);
  });
});
