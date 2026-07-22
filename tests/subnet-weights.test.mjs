import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetWeights,
  SUBNET_WEIGHTS_WINDOWS,
  DEFAULT_SUBNET_WEIGHTS_WINDOW,
} from "../src/subnet-weights.ts";

describe("buildSubnetWeights", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetWeights(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_setters, 0);
      assert.equal(d.weight_sets, 0);
      assert.equal(d.sets_per_setter, null); // no setters -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetWeights({}, 7).window, null);
  });

  test("computes distinct setters, event count, and updates-per-validator", () => {
    const d = buildSubnetWeights(
      { distinct_setters: 4, weight_sets: 40, newest_observed: 1750000000000 },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_setters, 4);
    assert.equal(d.weight_sets, 40);
    assert.equal(d.sets_per_setter, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds sets_per_setter to 2dp", () => {
    const d = buildSubnetWeights({ distinct_setters: 3, weight_sets: 40 }, 7);
    assert.equal(d.sets_per_setter, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetWeights({ newest_observed: "1750000000000" }, 7).observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetWeights({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetWeights(
      { distinct_setters: "5", weight_sets: "50" },
      7,
    );
    assert.equal(d.distinct_setters, 5);
    assert.equal(d.weight_sets, 50);
    assert.equal(d.sets_per_setter, 10);
    const z = buildSubnetWeights({ distinct_setters: -3, weight_sets: "x" }, 7);
    assert.equal(z.distinct_setters, 0);
    assert.equal(z.weight_sets, 0);
    assert.equal(z.sets_per_setter, null);
  });
});

describe("subnet-weights window exports", () => {
  test("exposes the window map + default matching /chain/weights", () => {
    assert.deepEqual(SUBNET_WEIGHTS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_WEIGHTS_WINDOW, "7d");
  });
});
