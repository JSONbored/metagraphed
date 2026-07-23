import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetDeregistrations,
  loadSubnetDeregistrations,
  DEREGISTRATION_EVENT_KIND,
  SUBNET_DEREGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW,
} from "../src/subnet-deregistrations.ts";
import type { Row } from "./row-type.ts";

describe("buildSubnetDeregistrations", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetDeregistrations(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_deregistered_hotkeys, 0);
      assert.equal(d.deregistrations, 0);
      assert.equal(d.deregistrations_per_hotkey, null); // no hotkeys -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetDeregistrations({}, 7).window, null);
  });

  test("computes distinct hotkeys, deregistration count, and deregistrations-per-hotkey", () => {
    const d = buildSubnetDeregistrations(
      {
        distinct_deregistered_hotkeys: 4,
        deregistrations: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_deregistered_hotkeys, 4);
    assert.equal(d.deregistrations, 40);
    assert.equal(d.deregistrations_per_hotkey, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds deregistrations_per_hotkey to 2dp", () => {
    const d = buildSubnetDeregistrations(
      { distinct_deregistered_hotkeys: 3, deregistrations: 40 },
      7,
    );
    assert.equal(d.deregistrations_per_hotkey, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetDeregistrations({ newest_observed: "1750000000000" }, 7)
        .observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetDeregistrations({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetDeregistrations(
      { distinct_deregistered_hotkeys: "5", deregistrations: "50" },
      7,
    );
    assert.equal(d.distinct_deregistered_hotkeys, 5);
    assert.equal(d.deregistrations, 50);
    assert.equal(d.deregistrations_per_hotkey, 10);
    const z = buildSubnetDeregistrations(
      { distinct_deregistered_hotkeys: -3, deregistrations: "x" },
      7,
    );
    assert.equal(z.distinct_deregistered_hotkeys, 0);
    assert.equal(z.deregistrations, 0);
    assert.equal(z.deregistrations_per_hotkey, null);
  });
});

describe("loadSubnetDeregistrations", () => {
  test("queries account_events for the netuid + NeuronDeregistered over the window and shapes it", async () => {
    let captured: Row | undefined;
    const d1 = async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return [
        {
          distinct_deregistered_hotkeys: 2,
          deregistrations: 20,
          newest_observed: 1750000000000,
        },
      ];
    };
    const d = await loadSubnetDeregistrations(d1, 7, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.match(captured!.sql, /FROM account_events/);
    assert.match(captured!.sql, /netuid = \?/);
    assert.equal(captured!.params[0], 7);
    assert.equal(captured!.params[1], DEREGISTRATION_EVENT_KIND);
    assert.equal(typeof captured!.params[2], "number"); // cutoff epoch ms
    assert.equal(d.netuid, 7);
    assert.equal(d.window, "7d");
    assert.equal(d.deregistrations, 20);
    assert.equal(d.deregistrations_per_hotkey, 10);
  });

  test("a cold store (no rows) yields the zeroed card", async () => {
    const d = await loadSubnetDeregistrations(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.netuid, 9);
    assert.equal(d.deregistrations, 0);
    assert.equal(d.deregistrations_per_hotkey, null);
  });

  test("exposes the window map + default matching the sibling account_events routes", () => {
    assert.deepEqual(SUBNET_DEREGISTRATIONS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_DEREGISTRATIONS_WINDOW, "7d");
  });
});
