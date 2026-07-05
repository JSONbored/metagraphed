import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountStakeTransfers,
  loadAccountStakeTransfers,
  STAKE_TRANSFERRED_EVENT_KIND,
  DEFAULT_ACCOUNT_STAKE_TRANSFERS_WINDOW,
} from "../src/account-stake-transfers.mjs";

function row(netuid, transfers, first, last) {
  return {
    netuid,
    transfers,
    first_observed: first,
    last_observed: last,
  };
}

const ADDR = "5GReferenceAccountAddressForStakeTransfersTestss";

describe("buildAccountStakeTransfers", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildAccountStakeTransfers(rows, ADDR, { window: "30d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.address, ADDR);
      assert.equal(d.window, "30d");
      assert.equal(d.total_transfers, 0);
      assert.equal(d.subnet_count, 0);
      assert.equal(d.concentration, null);
      assert.equal(d.dominant_netuid, null);
      assert.deepEqual(d.subnets, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildAccountStakeTransfers([], ADDR).window, null);
  });

  test("folds per-subnet transfer counts + first/last timestamps", () => {
    const d = buildAccountStakeTransfers(
      [
        row(1, 3, 1_700_000_000_000, 1_700_500_000_000),
        row(7, 1, 1_700_100_000_000, 1_700_100_000_000),
      ],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.total_transfers, 4);
    assert.equal(d.subnet_count, 2);
    assert.equal(d.subnets[0].netuid, 1);
    assert.equal(d.dominant_netuid, 1);
    const s1 = d.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.transfers, 3);
    assert.equal(
      s1.first_transferred_at,
      new Date(1_700_000_000_000).toISOString(),
    );
    assert.equal(
      s1.last_transferred_at,
      new Date(1_700_500_000_000).toISOString(),
    );
  });

  test("HHI concentration: all transfers on one subnet -> 1, spread -> < 1", () => {
    const one = buildAccountStakeTransfers([row(1, 5, 1000, 2000)], ADDR, {
      window: "7d",
    });
    assert.equal(one.concentration, 1);

    const split = buildAccountStakeTransfers(
      [row(1, 3, 1000, 2000), row(2, 3, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(split.concentration, 0.5);
  });

  test("never rounds a sub-perfect concentration up to exactly 1", () => {
    const d = buildAccountStakeTransfers(
      [row(1, 100000, 1000, 2000), row(2, 1, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(d.concentration, 0.9999);
    assert.equal(d.subnet_count, 2);
  });

  test("ties on transfer count break by netuid ascending", () => {
    const d = buildAccountStakeTransfers(
      [row(9, 4, 1000, 2000), row(4, 4, 1000, 2000)],
      ADDR,
      { window: "30d" },
    );
    assert.deepEqual(
      d.subnets.map((s) => s.netuid),
      [4, 9],
    );
    assert.equal(d.dominant_netuid, 4);
  });

  test("merges duplicate netuid rows and keeps the widest first/last span", () => {
    const d = buildAccountStakeTransfers(
      [row(1, 2, 3000, 4000), row(1, 1, 1000, 3500), row(1, 1, 2000, 5000)],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.subnet_count, 1);
    const s = d.subnets[0];
    assert.equal(s.transfers, 4);
    assert.equal(s.first_transferred_at, new Date(1000).toISOString());
    assert.equal(s.last_transferred_at, new Date(5000).toISOString());
  });

  test("skips malformed/blank/negative netuid and zero-count rows", () => {
    const d = buildAccountStakeTransfers(
      [
        row(1, 4, 1000, 2000),
        { netuid: null, transfers: 3 },
        { netuid: "", transfers: 3 },
        { netuid: "bad", transfers: 3 },
        { netuid: -1, transfers: 3 },
        row(2, 0, 1000, 2000),
        row(3, -5, 1000, 2000),
        row(4, "not-a-count", 1000, 2000),
      ],
      ADDR,
      { window: "7d" },
    );
    assert.equal(d.subnet_count, 1);
    assert.equal(d.subnets[0].netuid, 1);
  });

  test("null / out-of-range observed timestamps degrade to null, not a 1970 stamp", () => {
    const d = buildAccountStakeTransfers(
      [row(1, 2, 0, -5), row(2, 1, null, 9e15)],
      ADDR,
      { window: "7d" },
    );
    const s1 = d.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.first_transferred_at, null);
    assert.equal(s1.last_transferred_at, null);
    const s2 = d.subnets.find((s) => s.netuid === 2);
    assert.equal(s2.first_transferred_at, null);
    assert.equal(s2.last_transferred_at, null);
  });
});

describe("loadAccountStakeTransfers", () => {
  test("seeks the coldkey index for StakeTransferred over the window and shapes it", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [
        row(1, 3, 1_700_000_000_000, 1_700_000_000_000),
        row(2, 1, 1_700_400_000_000, 1_700_500_000_000),
        row(3, 1, null, null),
      ];
    };
    const { data, generatedAt } = await loadAccountStakeTransfers(d1, ADDR, {
      windowLabel: "7d",
    });
    assert.match(
      captured.sql,
      /FROM account_events INDEXED BY idx_account_events_coldkey/,
    );
    assert.match(captured.sql, /WHERE coldkey = \? AND event_kind = \?/);
    assert.match(captured.sql, /GROUP BY netuid/);
    assert.equal(captured.params[0], ADDR);
    assert.equal(captured.params[1], STAKE_TRANSFERRED_EVENT_KIND);
    assert.equal(typeof captured.params[2], "number");
    assert.equal(data.total_transfers, 5);
    assert.equal(generatedAt, new Date(1_700_500_000_000).toISOString());
  });

  test("an unknown window label falls back to the default window days", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [];
    };
    await loadAccountStakeTransfers(d1, ADDR, { windowLabel: "bogus" });
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(captured.params[2] - expected) < 24 * 60 * 60 * 1000);
  });

  test("a cold store yields a zeroed card + null generatedAt", async () => {
    const { data, generatedAt } = await loadAccountStakeTransfers(
      async () => [],
      ADDR,
      { windowLabel: DEFAULT_ACCOUNT_STAKE_TRANSFERS_WINDOW },
    );
    assert.equal(data.total_transfers, 0);
    assert.equal(data.subnet_count, 0);
    assert.equal(generatedAt, null);
  });

  test("a non-array D1 result degrades to a zeroed card", async () => {
    const { data, generatedAt } = await loadAccountStakeTransfers(
      async () => null,
      ADDR,
      { windowLabel: "7d" },
    );
    assert.equal(data.total_transfers, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(generatedAt, null);
  });
});
