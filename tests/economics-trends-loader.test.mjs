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
  // D1 fully eliminated (2026-07-17): subnet_snapshots is Postgres-only now,
  // so this loader is only reached on a tier miss and always returns the
  // schema-stable empty shape (via buildEconomicsTrends([], { capped: false })).
  test("returns schema-stable empty days for a bounded window (D1 retired)", async () => {
    const { data, rows } = await loadEconomicsTrends({ windowLabel: "7d" });
    assert.deepEqual(rows, []);
    assert.equal(data.window, "7d");
    assert.equal(data.day_count, 0);
    assert.deepEqual(data.days, []);
  });

  test("returns schema-stable empty days for the all window (D1 retired)", async () => {
    const { data, rows } = await loadEconomicsTrends({ windowLabel: "all" });
    assert.deepEqual(rows, []);
    assert.equal(data.window, "all");
    assert.equal(data.day_count, 0);
    assert.deepEqual(data.days, []);
  });
});

// ECONOMICS_TRENDS_ROW_CAP stays exported for buildEconomicsTrends's own
// capping tests (see neuron-history.test.mjs); referenced here to keep the
// import (and the constant's row-cap contract) exercised.
describe("ECONOMICS_TRENDS_ROW_CAP", () => {
  test("is a finite positive row cap", () => {
    assert.ok(Number.isInteger(ECONOMICS_TRENDS_ROW_CAP));
    assert.ok(ECONOMICS_TRENDS_ROW_CAP > 0);
  });
});
