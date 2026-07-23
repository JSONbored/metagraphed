import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetRegistrations,
  loadSubnetRegistrations,
  REGISTRATION_EVENT_KIND,
  SUBNET_REGISTRATIONS_WINDOWS,
  DEFAULT_SUBNET_REGISTRATIONS_WINDOW,
} from "../src/subnet-registrations.ts";
import type { Row } from "./row-type.ts";

describe("buildSubnetRegistrations", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetRegistrations(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_registrants, 0);
      assert.equal(d.registrations, 0);
      assert.equal(d.registrations_per_registrant, null); // no registrants -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetRegistrations({}, 7).window, null);
  });

  test("computes distinct registrants, event count, and registrations-per-registrant", () => {
    const d = buildSubnetRegistrations(
      {
        distinct_registrants: 4,
        registrations: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_registrants, 4);
    assert.equal(d.registrations, 40);
    assert.equal(d.registrations_per_registrant, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds registrations_per_registrant to 2dp", () => {
    const d = buildSubnetRegistrations(
      { distinct_registrants: 3, registrations: 40 },
      7,
    );
    assert.equal(d.registrations_per_registrant, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetRegistrations({ newest_observed: "1750000000000" }, 7)
        .observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetRegistrations({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetRegistrations(
      { distinct_registrants: "5", registrations: "50" },
      7,
    );
    assert.equal(d.distinct_registrants, 5);
    assert.equal(d.registrations, 50);
    assert.equal(d.registrations_per_registrant, 10);
    const z = buildSubnetRegistrations(
      { distinct_registrants: -3, registrations: "x" },
      7,
    );
    assert.equal(z.distinct_registrants, 0);
    assert.equal(z.registrations, 0);
    assert.equal(z.registrations_per_registrant, null);
  });
});

describe("loadSubnetRegistrations", () => {
  test("queries account_events for the netuid + NeuronRegistered over the window and shapes it", async () => {
    let captured: Row | undefined;
    const d1 = async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return [
        {
          distinct_registrants: 2,
          registrations: 20,
          newest_observed: 1750000000000,
        },
      ];
    };
    const d = await loadSubnetRegistrations(d1, 7, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.match(captured!.sql, /FROM account_events/);
    assert.match(captured!.sql, /netuid = \?/);
    assert.equal(captured!.params[0], 7);
    assert.equal(captured!.params[1], REGISTRATION_EVENT_KIND);
    assert.equal(typeof captured!.params[2], "number"); // cutoff epoch ms
    assert.equal(d.netuid, 7);
    assert.equal(d.window, "7d");
    assert.equal(d.registrations, 20);
    assert.equal(d.registrations_per_registrant, 10);
  });

  test("a cold store (no rows) yields the zeroed card", async () => {
    const d = await loadSubnetRegistrations(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.netuid, 9);
    assert.equal(d.registrations, 0);
    assert.equal(d.registrations_per_registrant, null);
  });

  test("exposes the window map + default", () => {
    assert.deepEqual(SUBNET_REGISTRATIONS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_REGISTRATIONS_WINDOW, "7d");
  });
});
