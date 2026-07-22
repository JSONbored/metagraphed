import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetStakeTransfers,
  loadSubnetStakeTransfers,
  STAKE_TRANSFERRED_EVENT_KIND,
  SUBNET_STAKE_TRANSFERS_WINDOWS,
  DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW,
} from "../src/subnet-stake-transfers.ts";

describe("buildSubnetStakeTransfers", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetStakeTransfers(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_senders, 0);
      assert.equal(d.transfers, 0);
      assert.equal(d.transfers_per_sender, null); // no senders -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetStakeTransfers({}, 7).window, null);
  });

  test("computes distinct senders, transfer count, and transfers-per-sender", () => {
    const d = buildSubnetStakeTransfers(
      {
        distinct_senders: 4,
        transfers: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_senders, 4);
    assert.equal(d.transfers, 40);
    assert.equal(d.transfers_per_sender, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds transfers_per_sender to 2dp", () => {
    const d = buildSubnetStakeTransfers(
      { distinct_senders: 3, transfers: 40 },
      7,
    );
    assert.equal(d.transfers_per_sender, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetStakeTransfers({ newest_observed: "1750000000000" }, 7)
        .observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetStakeTransfers({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetStakeTransfers(
      { distinct_senders: "5", transfers: "50" },
      7,
    );
    assert.equal(d.distinct_senders, 5);
    assert.equal(d.transfers, 50);
    assert.equal(d.transfers_per_sender, 10);
    const z = buildSubnetStakeTransfers(
      { distinct_senders: -3, transfers: "x" },
      7,
    );
    assert.equal(z.distinct_senders, 0);
    assert.equal(z.transfers, 0);
    assert.equal(z.transfers_per_sender, null);
  });
});

describe("loadSubnetStakeTransfers", () => {
  test("queries account_events for the netuid + StakeTransferred over the window and shapes it", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [
        {
          distinct_senders: 2,
          transfers: 20,
          newest_observed: 1750000000000,
        },
      ];
    };
    const before = Date.now();
    const d = await loadSubnetStakeTransfers(d1, 7, {
      windowLabel: "7d",
      windowDays: 7,
    });
    const after = Date.now();
    // Pin the full predicate: netuid + event_kind + the observed_at window bound, all parameterized
    // in that column order, so a future SQL edit that drops the window filter fails the test.
    assert.match(captured.sql, /FROM account_events/);
    assert.match(captured.sql, /COUNT\(\*\) AS transfers/);
    assert.match(captured.sql, /COUNT\(DISTINCT coldkey\) AS distinct_senders/);
    assert.match(
      captured.sql,
      /WHERE netuid = \? AND event_kind = \? AND observed_at >= \?/,
    );
    assert.equal(captured.params[0], 7);
    assert.equal(captured.params[1], STAKE_TRANSFERRED_EVENT_KIND);
    // The cutoff is now - windowDays (7d) in epoch ms, bounded by the call's wall-clock window.
    const dayMs = 24 * 60 * 60 * 1000;
    assert.ok(captured.params[2] >= before - 7 * dayMs - 5);
    assert.ok(captured.params[2] <= after - 7 * dayMs + 5);
    assert.equal(d.netuid, 7);
    assert.equal(d.window, "7d");
    assert.equal(d.transfers, 20);
    assert.equal(d.transfers_per_sender, 10);
  });

  test("a cold store (no rows) yields the zeroed card", async () => {
    const d = await loadSubnetStakeTransfers(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.netuid, 9);
    assert.equal(d.transfers, 0);
    assert.equal(d.transfers_per_sender, null);
  });

  test("exposes the window map + default matching /chain/stake-transfers", () => {
    assert.deepEqual(SUBNET_STAKE_TRANSFERS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_STAKE_TRANSFERS_WINDOW, "7d");
  });
});
