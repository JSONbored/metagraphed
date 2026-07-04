import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetPrometheus,
  loadSubnetPrometheus,
  PROMETHEUS_EVENT_KIND,
  SUBNET_PROMETHEUS_WINDOWS,
  DEFAULT_SUBNET_PROMETHEUS_WINDOW,
} from "../src/subnet-prometheus.mjs";

describe("buildSubnetPrometheus", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetPrometheus(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_exporters, 0);
      assert.equal(d.announcements, 0);
      assert.equal(d.announcements_per_exporter, null); // no exporters -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetPrometheus({}, 7).window, null);
  });

  test("computes distinct exporters, announcement count, and announcements-per-exporter", () => {
    const d = buildSubnetPrometheus(
      {
        distinct_exporters: 4,
        announcements: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_exporters, 4);
    assert.equal(d.announcements, 40);
    assert.equal(d.announcements_per_exporter, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds announcements_per_exporter to 2dp", () => {
    const d = buildSubnetPrometheus(
      { distinct_exporters: 3, announcements: 40 },
      7,
    );
    assert.equal(d.announcements_per_exporter, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetPrometheus({ newest_observed: "1750000000000" }, 7)
        .observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetPrometheus({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetPrometheus(
      { distinct_exporters: "5", announcements: "50" },
      7,
    );
    assert.equal(d.distinct_exporters, 5);
    assert.equal(d.announcements, 50);
    assert.equal(d.announcements_per_exporter, 10);
    const z = buildSubnetPrometheus(
      { distinct_exporters: -3, announcements: "x" },
      7,
    );
    assert.equal(z.distinct_exporters, 0);
    assert.equal(z.announcements, 0);
    assert.equal(z.announcements_per_exporter, null);
  });
});

describe("loadSubnetPrometheus", () => {
  test("queries account_events for the netuid + PrometheusServed over the window and shapes it", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [
        {
          distinct_exporters: 2,
          announcements: 20,
          newest_observed: 1750000000000,
        },
      ];
    };
    const d = await loadSubnetPrometheus(d1, 7, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.match(captured.sql, /FROM account_events/);
    assert.match(captured.sql, /netuid = \?/);
    assert.equal(captured.params[0], 7);
    assert.equal(captured.params[1], PROMETHEUS_EVENT_KIND);
    assert.equal(typeof captured.params[2], "number"); // cutoff epoch ms
    assert.equal(d.netuid, 7);
    assert.equal(d.window, "7d");
    assert.equal(d.announcements, 20);
    assert.equal(d.announcements_per_exporter, 10);
  });

  test("a cold store (no rows) yields the zeroed card", async () => {
    const d = await loadSubnetPrometheus(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.netuid, 9);
    assert.equal(d.announcements, 0);
    assert.equal(d.announcements_per_exporter, null);
  });

  test("exposes the window map + default matching /chain/prometheus", () => {
    assert.deepEqual(SUBNET_PROMETHEUS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_PROMETHEUS_WINDOW, "7d");
  });
});
