import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountDeregistrations,
  loadAccountDeregistrations,
  DEREGISTRATION_EVENT_KIND,
  DEFAULT_DEREGISTRATION_WINDOW,
} from "../src/account-deregistrations.ts";

// One GROUP BY netuid row (deregistration count + first/last observed epoch ms).
function row(
  netuid: number | string | null,
  deregistrations: number,
  first: number | null,
  last: number | null,
): Record<string, unknown> {
  return {
    netuid,
    deregistrations,
    first_observed: first,
    last_observed: last,
  };
}

const ADDR = "5GReferenceAccountAddressForDeregTestssssssssssss";

describe("buildAccountDeregistrations", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildAccountDeregistrations(rows, ADDR, { window: "30d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.address, ADDR);
      assert.equal(d.window, "30d");
      assert.equal(d.total_deregistrations, 0);
      assert.equal(d.subnet_count, 0);
      assert.equal(d.concentration, null);
      assert.equal(d.dominant_netuid, null);
      assert.deepEqual(d.subnets, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildAccountDeregistrations([], ADDR).window, null);
  });

  test("folds per-subnet eviction counts + first/last timestamps", () => {
    const d = buildAccountDeregistrations(
      [
        row(1, 3, 1_700_000_000_000, 1_700_500_000_000),
        row(7, 1, 1_700_100_000_000, 1_700_100_000_000),
      ],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.total_deregistrations, 4);
    assert.equal(d.subnet_count, 2);
    // subnet 1 has the most deregistrations (3), so it leads + is dominant.
    assert.equal(d.subnets[0].netuid, 1);
    assert.equal(d.dominant_netuid, 1);
    const s1 = d.subnets.find((s) => s.netuid === 1)!;
    assert.equal(s1.deregistrations, 3);
    assert.equal(
      s1.first_deregistered_at,
      new Date(1_700_000_000_000).toISOString(),
    );
    assert.equal(
      s1.last_deregistered_at,
      new Date(1_700_500_000_000).toISOString(),
    );
  });

  test("HHI concentration: all deregistrations on one subnet -> 1, spread -> < 1", () => {
    const one = buildAccountDeregistrations([row(1, 5, 1000, 2000)], ADDR, {
      window: "7d",
    });
    assert.equal(one.concentration, 1);
    // 3 and 3 across two subnets: HHI = (9 + 9) / 36 = 0.5.
    const split = buildAccountDeregistrations(
      [row(1, 3, 1000, 2000), row(2, 3, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(split.concentration, 0.5);
  });

  test("never rounds a sub-perfect concentration up to exactly 1", () => {
    // Extreme skew (100000 vs 1): HHI ≈ 0.99998, which rounds to 1.0000 at 4dp but is < 1 —
    // the anti-overstatement clamp holds it at 0.9999.
    const d = buildAccountDeregistrations(
      [row(1, 100000, 1000, 2000), row(2, 1, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(d.concentration, 0.9999);
    assert.equal(d.subnet_count, 2);
  });

  test("ties on eviction count break by netuid ascending", () => {
    const d = buildAccountDeregistrations(
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
    const d = buildAccountDeregistrations(
      [row(1, 2, 3000, 4000), row(1, 1, 1000, 5000)],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.subnet_count, 1);
    const s = d.subnets[0];
    assert.equal(s.deregistrations, 3); // 2 + 1
    assert.equal(s.first_deregistered_at, new Date(1000).toISOString()); // min
    assert.equal(s.last_deregistered_at, new Date(5000).toISOString()); // max
  });

  test("skips malformed/blank/negative netuid and zero-count rows", () => {
    const d = buildAccountDeregistrations(
      [
        row(1, 4, 1000, 2000),
        { netuid: null, deregistrations: 3 },
        { netuid: "", deregistrations: 3 },
        { netuid: "bad", deregistrations: 3 },
        { netuid: -1, deregistrations: 3 },
        row(2, 0, 1000, 2000), // zero deregistrations: skipped
      ],
      ADDR,
      { window: "7d" },
    );
    assert.equal(d.subnet_count, 1);
    assert.equal(d.subnets[0].netuid, 1);
  });

  test("null / out-of-range observed timestamps degrade to null, not a 1970 stamp", () => {
    const d = buildAccountDeregistrations(
      [row(1, 2, 0, -5), row(2, 1, null, 9e15)],
      ADDR,
      { window: "7d" },
    );
    const s1 = d.subnets.find((s) => s.netuid === 1)!;
    assert.equal(s1.first_deregistered_at, null);
    assert.equal(s1.last_deregistered_at, null);
    const s2 = d.subnets.find((s) => s.netuid === 2)!;
    assert.equal(s2.first_deregistered_at, null);
    assert.equal(s2.last_deregistered_at, null);
  });
});

describe("loadAccountDeregistrations", () => {
  test("seeks the hotkey index for NeuronDeregistered over the window and shapes it", async () => {
    let captured: { sql: string; params: unknown[] } | undefined;
    const d1 = async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      // Multiple rows so generatedAt walks past the first (later row wins) and a
      // null-observed row is skipped rather than counted.
      return [
        row(1, 3, 1_700_000_000_000, 1_700_000_000_000),
        row(2, 1, 1_700_400_000_000, 1_700_500_000_000), // newer -> wins generatedAt
        row(3, 1, null, null), // no observed timestamp -> skipped for generatedAt
      ];
    };
    const { data, generatedAt } = await loadAccountDeregistrations(d1, ADDR, {
      windowLabel: "7d",
    });
    assert.match(
      captured!.sql,
      /FROM account_events INDEXED BY idx_account_events_hotkey/,
    );
    assert.match(captured!.sql, /WHERE hotkey = \? AND event_kind = \?/);
    assert.match(captured!.sql, /GROUP BY netuid/);
    assert.equal(captured!.params[0], ADDR);
    assert.equal(captured!.params[1], DEREGISTRATION_EVENT_KIND);
    assert.equal(typeof captured!.params[2], "number"); // epoch-ms cutoff
    assert.equal(data.total_deregistrations, 5);
    assert.equal(generatedAt, new Date(1_700_500_000_000).toISOString());
  });

  test("an unknown window label falls back to the default window days", async () => {
    let captured: { sql: string; params: unknown[] } | undefined;
    const d1 = async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return [];
    };
    await loadAccountDeregistrations(d1, ADDR, { windowLabel: "bogus" });
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    assert.ok(
      Math.abs((captured!.params[2] as number) - expected) <
        24 * 60 * 60 * 1000,
    );
  });

  test("a cold store (no rows) yields a zeroed card + null generatedAt", async () => {
    const { data, generatedAt } = await loadAccountDeregistrations(
      async () => [],
      ADDR,
      { windowLabel: DEFAULT_DEREGISTRATION_WINDOW },
    );
    assert.equal(data.total_deregistrations, 0);
    assert.equal(data.subnet_count, 0);
    assert.equal(generatedAt, null);
  });

  test("a non-array D1 result degrades to a zeroed card (never throws)", async () => {
    const { data, generatedAt } = await loadAccountDeregistrations(
      async () => null as unknown as Record<string, unknown>[],
      ADDR,
      { windowLabel: "7d" },
    );
    assert.equal(data.total_deregistrations, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(generatedAt, null);
  });
});
