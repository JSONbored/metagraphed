import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ECONOMICS_TRENDS_ROW_CAP,
  loadEconomicsTrends,
  parseEconomicsTrendsWindow,
} from "../src/economics-trends.mjs";

describe("parseEconomicsTrendsWindow", () => {
  test("defaults to 30d when window is omitted", () => {
    assert.deepEqual(parseEconomicsTrendsWindow(undefined), {
      label: "30d",
      days: 30,
    });
  });

  test("returns null for an unknown window label", () => {
    assert.equal(parseEconomicsTrendsWindow("99d"), null);
  });

  test("accepts all windows without a day bound", () => {
    assert.deepEqual(parseEconomicsTrendsWindow("all"), {
      label: "all",
      days: null,
    });
  });
});

describe("loadEconomicsTrends", () => {
  test("queries subnet_snapshots and rolls rows through buildEconomicsTrends", async () => {
    const now = Date.parse("2026-06-25T00:00:00Z");
    let capturedSql = "";
    let capturedParams = [];
    const d1 = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return [
        {
          snapshot_date: "2026-06-10",
          total_stake_tao: 1000,
          alpha_price_tao: 0.06,
          validator_count: 12,
          miner_count: 200,
          emission_share: 0.05,
        },
      ];
    };
    const { data, rows } = await loadEconomicsTrends(d1, {
      windowLabel: "7d",
      windowDays: 7,
      now,
    });
    assert.match(capturedSql, /FROM subnet_snapshots/);
    assert.equal(capturedParams.at(-1), ECONOMICS_TRENDS_ROW_CAP);
    assert.equal(capturedParams[0], "2026-06-18");
    assert.equal(rows.length, 1);
    assert.equal(data.window, "7d");
    assert.equal(data.day_count, 1);
    assert.equal(data.days[0].total_stake_tao, 1000);
  });

  test("omits the date lower bound for the all window", async () => {
    const d1 = async (sql, params) => {
      assert.doesNotMatch(sql, /snapshot_date >=/);
      assert.equal(params.at(-1), ECONOMICS_TRENDS_ROW_CAP);
      return [];
    };
    const { data } = await loadEconomicsTrends(d1, {
      windowLabel: "all",
      windowDays: null,
    });
    assert.equal(data.window, "all");
    assert.equal(data.day_count, 0);
    assert.deepEqual(data.days, []);
  });
});
