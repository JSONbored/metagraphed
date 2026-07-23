import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetAxonRemovals,
  loadSubnetAxonRemovals,
  AXON_REMOVAL_EVENT_KIND,
  SUBNET_AXON_REMOVALS_WINDOWS,
  DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
} from "../src/subnet-axon-removals.ts";
import type { Row } from "./row-type.ts";

describe("buildSubnetAxonRemovals", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetAxonRemovals(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_removers, 0);
      assert.equal(d.removals, 0);
      assert.equal(d.removals_per_remover, null); // no removers -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetAxonRemovals({}, 7).window, null);
  });

  test("computes distinct removers, removal count, and removals-per-remover", () => {
    const d = buildSubnetAxonRemovals(
      {
        distinct_removers: 4,
        removals: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_removers, 4);
    assert.equal(d.removals, 40);
    assert.equal(d.removals_per_remover, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds removals_per_remover to 2dp", () => {
    const d = buildSubnetAxonRemovals(
      { distinct_removers: 3, removals: 40 },
      7,
    );
    assert.equal(d.removals_per_remover, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetAxonRemovals({ newest_observed: "1750000000000" }, 7)
        .observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetAxonRemovals({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetAxonRemovals(
      { distinct_removers: "5", removals: "50" },
      7,
    );
    assert.equal(d.distinct_removers, 5);
    assert.equal(d.removals, 50);
    assert.equal(d.removals_per_remover, 10);
    const z = buildSubnetAxonRemovals(
      { distinct_removers: -3, removals: "x" },
      7,
    );
    assert.equal(z.distinct_removers, 0);
    assert.equal(z.removals, 0);
    assert.equal(z.removals_per_remover, null);
  });
});

describe("loadSubnetAxonRemovals", () => {
  test("queries account_events for the netuid + AxonInfoRemoved over the window and shapes it", async () => {
    let captured: Row | undefined;
    const d1 = async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return [
        {
          distinct_removers: 2,
          removals: 20,
          newest_observed: 1750000000000,
        },
      ];
    };
    const d = await loadSubnetAxonRemovals(d1, 7, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.match(captured!.sql, /FROM account_events/);
    assert.match(captured!.sql, /netuid = \?/);
    assert.equal(captured!.params[0], 7);
    assert.equal(captured!.params[1], AXON_REMOVAL_EVENT_KIND);
    assert.equal(typeof captured!.params[2], "number"); // cutoff epoch ms
    assert.equal(d.netuid, 7);
    assert.equal(d.window, "7d");
    assert.equal(d.removals, 20);
    assert.equal(d.removals_per_remover, 10);
  });

  test("a cold store (no rows) yields the zeroed card", async () => {
    const d = await loadSubnetAxonRemovals(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.netuid, 9);
    assert.equal(d.removals, 0);
    assert.equal(d.removals_per_remover, null);
  });

  test("exposes the window map + default matching the sibling account_events routes", () => {
    assert.deepEqual(SUBNET_AXON_REMOVALS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_AXON_REMOVALS_WINDOW, "7d");
  });
});
