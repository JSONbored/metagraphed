import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetServing,
  loadSubnetServing,
  SERVING_EVENT_KIND,
  SUBNET_SERVING_WINDOWS,
  DEFAULT_SUBNET_SERVING_WINDOW,
} from "../src/subnet-serving.mjs";

describe("buildSubnetServing", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetServing(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_servers, 0);
      assert.equal(d.announcements, 0);
      assert.equal(d.announcements_per_server, null); // no servers -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetServing({}, 7).window, null);
  });

  test("computes distinct servers, announcement count, and announcements-per-server", () => {
    const d = buildSubnetServing(
      {
        distinct_servers: 4,
        announcements: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_servers, 4);
    assert.equal(d.announcements, 40);
    assert.equal(d.announcements_per_server, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds announcements_per_server to 2dp", () => {
    const d = buildSubnetServing({ distinct_servers: 3, announcements: 40 }, 7);
    assert.equal(d.announcements_per_server, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetServing({ newest_observed: "1750000000000" }, 7).observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetServing({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetServing(
      { distinct_servers: "5", announcements: "50" },
      7,
    );
    assert.equal(d.distinct_servers, 5);
    assert.equal(d.announcements, 50);
    assert.equal(d.announcements_per_server, 10);
    const z = buildSubnetServing(
      { distinct_servers: -3, announcements: "x" },
      7,
    );
    assert.equal(z.distinct_servers, 0);
    assert.equal(z.announcements, 0);
    assert.equal(z.announcements_per_server, null);
  });
});

describe("loadSubnetServing", () => {
  test("queries account_events for the netuid + AxonServed over the window and shapes it", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [
        {
          distinct_servers: 2,
          announcements: 20,
          newest_observed: 1750000000000,
        },
      ];
    };
    const d = await loadSubnetServing(d1, 7, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.match(captured.sql, /FROM account_events/);
    assert.match(captured.sql, /netuid = \?/);
    assert.equal(captured.params[0], 7);
    assert.equal(captured.params[1], SERVING_EVENT_KIND);
    assert.equal(typeof captured.params[2], "number"); // cutoff epoch ms
    assert.equal(d.netuid, 7);
    assert.equal(d.window, "7d");
    assert.equal(d.announcements, 20);
    assert.equal(d.announcements_per_server, 10);
  });

  test("a cold store (no rows) yields the zeroed card", async () => {
    const d = await loadSubnetServing(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.netuid, 9);
    assert.equal(d.announcements, 0);
    assert.equal(d.announcements_per_server, null);
  });

  test("exposes the window map + default matching /chain/serving", () => {
    assert.deepEqual(SUBNET_SERVING_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_SERVING_WINDOW, "7d");
  });
});
