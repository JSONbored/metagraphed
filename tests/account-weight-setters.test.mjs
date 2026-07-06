import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountWeightSetters,
  loadAccountWeightSetters,
  WEIGHTS_EVENT_KIND,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
} from "../src/account-weight-setters.mjs";

// One GROUP BY netuid row (weight_sets count + first/last observed epoch ms).
function row(netuid, weightSets, first, last) {
  return {
    netuid,
    weight_sets: weightSets,
    first_observed: first,
    last_observed: last,
  };
}

const ADDR = "5GReferenceAccountAddressForWeightSettersTestsssssss";

describe("buildAccountWeightSetters", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildAccountWeightSetters(rows, ADDR, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.address, ADDR);
      assert.equal(d.window, "7d");
      assert.equal(d.total_weight_sets, 0);
      assert.equal(d.subnet_count, 0);
      assert.equal(d.concentration, null);
      assert.equal(d.dominant_netuid, null);
      assert.deepEqual(d.subnets, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildAccountWeightSetters([], ADDR).window, null);
  });

  test("folds per-subnet weight-set counts + first/last timestamps", () => {
    const d = buildAccountWeightSetters(
      [
        row(1, 3, 1_700_000_000_000, 1_700_500_000_000),
        row(7, 1, 1_700_100_000_000, 1_700_100_000_000),
      ],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.total_weight_sets, 4);
    assert.equal(d.subnet_count, 2);
    // subnet 1 has the most weight sets (3), so it leads + is dominant.
    assert.equal(d.subnets[0].netuid, 1);
    assert.equal(d.dominant_netuid, 1);
    const s1 = d.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.weight_sets, 3);
    assert.equal(s1.first_set_at, new Date(1_700_000_000_000).toISOString());
    assert.equal(s1.last_set_at, new Date(1_700_500_000_000).toISOString());
  });

  test("HHI concentration: all weight sets on one subnet -> 1, spread -> < 1", () => {
    const one = buildAccountWeightSetters([row(1, 5, 1000, 2000)], ADDR, {
      window: "7d",
    });
    assert.equal(one.concentration, 1);
    // 3 and 3 across two subnets: HHI = (9 + 9) / 36 = 0.5.
    const split = buildAccountWeightSetters(
      [row(1, 3, 1000, 2000), row(2, 3, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(split.concentration, 0.5);
  });

  test("never rounds a sub-perfect concentration up to exactly 1", () => {
    // Extreme skew (100000 vs 1): HHI = (1e10 + 1) / 100001^2 ≈ 0.99998, which rounds to
    // 1.0000 at 4dp but is < 1 — the anti-overstatement clamp holds it at 0.9999 so a validator
    // spread across two subnets never reads as "all in one".
    const d = buildAccountWeightSetters(
      [row(1, 100000, 1000, 2000), row(2, 1, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(d.concentration, 0.9999);
    assert.equal(d.subnet_count, 2);
  });

  test("ties on weight-set count break by netuid ascending", () => {
    const d = buildAccountWeightSetters(
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
    const d = buildAccountWeightSetters(
      [row(1, 2, 3000, 4000), row(1, 1, 1000, 5000)],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.subnet_count, 1);
    const s = d.subnets[0];
    assert.equal(s.weight_sets, 3); // 2 + 1
    assert.equal(s.first_set_at, new Date(1000).toISOString()); // min
    assert.equal(s.last_set_at, new Date(5000).toISOString()); // max
  });

  test("skips malformed/blank/negative netuid and zero-count rows", () => {
    const d = buildAccountWeightSetters(
      [
        row(1, 4, 1000, 2000),
        { netuid: null, weight_sets: 3 },
        { netuid: "", weight_sets: 3 },
        { netuid: "bad", weight_sets: 3 },
        { netuid: -1, weight_sets: 3 },
        row(2, 0, 1000, 2000), // zero weight sets: skipped
      ],
      ADDR,
      { window: "7d" },
    );
    assert.equal(d.subnet_count, 1);
    assert.equal(d.subnets[0].netuid, 1);
  });

  test("null / out-of-range observed timestamps degrade to null, not a 1970 stamp", () => {
    const d = buildAccountWeightSetters(
      [row(1, 2, 0, -5), row(2, 1, null, 9e15)],
      ADDR,
      { window: "7d" },
    );
    const s1 = d.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.first_set_at, null);
    assert.equal(s1.last_set_at, null);
    const s2 = d.subnets.find((s) => s.netuid === 2);
    assert.equal(s2.first_set_at, null);
    assert.equal(s2.last_set_at, null);
  });
});

describe("loadAccountWeightSetters", () => {
  test("queries direct and uid-resolved WeightsSet rows over the window and shapes them", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      // Multiple rows so generatedAt walks past the first (later row wins) and a
      // null-observed row is skipped rather than counted.
      return [
        row(1, 3, 1_700_000_000_000, 1_700_000_000_000),
        row(2, 1, 1_700_400_000_000, 1_700_500_000_000), // newer -> wins generatedAt
        row(3, 1, null, null), // no observed timestamp -> skipped for generatedAt
      ];
    };
    const { data, generatedAt } = await loadAccountWeightSetters(d1, ADDR, {
      windowLabel: "7d",
    });
    assert.match(
      captured.sql,
      /FROM account_events INDEXED BY idx_account_events_hotkey/,
    );
    assert.match(captured.sql, /FROM neurons n INDEXED BY idx_neurons_hotkey/);
    assert.match(
      captured.sql,
      /JOIN account_events e INDEXED BY idx_account_events_netuid_uid_kind_observed/,
    );
    assert.doesNotMatch(captured.sql, /e\.hotkey = \? OR n\.hotkey = \?/);
    assert.match(captured.sql, /GROUP BY netuid/);
    assert.equal(captured.params[0], ADDR);
    assert.equal(captured.params[1], WEIGHTS_EVENT_KIND);
    assert.equal(typeof captured.params[2], "number"); // epoch-ms cutoff
    assert.equal(captured.params[3], ADDR);
    assert.equal(captured.params[4], WEIGHTS_EVENT_KIND);
    assert.equal(typeof captured.params[5], "number"); // epoch-ms cutoff
    assert.equal(data.total_weight_sets, 5);
    assert.equal(generatedAt, new Date(1_700_500_000_000).toISOString());
  });

  test("counts hotkey-less WeightsSet rows by resolving netuid and uid through neurons", async () => {
    const now = Date.now();
    const events = [
      {
        event_kind: WEIGHTS_EVENT_KIND,
        hotkey: null,
        netuid: 7,
        uid: 3,
        observed_at: now - 4_000,
      },
      {
        event_kind: WEIGHTS_EVENT_KIND,
        hotkey: "",
        netuid: 7,
        uid: 3,
        observed_at: now - 3_000,
      },
      {
        event_kind: WEIGHTS_EVENT_KIND,
        hotkey: null,
        netuid: 9,
        uid: 4,
        observed_at: now - 2_000,
      },
      {
        event_kind: WEIGHTS_EVENT_KIND,
        hotkey: null,
        netuid: 8,
        uid: 5,
        observed_at: now - 1_000,
      },
      {
        event_kind: WEIGHTS_EVENT_KIND,
        hotkey: ADDR,
        netuid: 11,
        uid: null,
        observed_at: now,
      },
    ];
    const neurons = [
      { netuid: 7, uid: 3, hotkey: ADDR },
      { netuid: 9, uid: 4, hotkey: ADDR },
      { netuid: 8, uid: 5, hotkey: "5DifferentHotkey" },
    ];
    const d1 = async (sql, params) => {
      const [
        directHotkey,
        directKind,
        directCutoff,
        resolvedHotkey,
        resolvedKind,
        resolvedCutoff,
      ] = params;
      assert.equal(directKind, WEIGHTS_EVENT_KIND);
      assert.equal(resolvedKind, WEIGHTS_EVENT_KIND);
      assert.equal(directCutoff, resolvedCutoff);
      const kind = directKind;
      const cutoff = directCutoff;
      const grouped = events
        .filter(
          (event) => event.event_kind === kind && event.observed_at >= cutoff,
        )
        .filter((event) => {
          if (event.hotkey === directHotkey) return true;
          if (event.hotkey != null && event.hotkey !== "") return false;
          return neurons.some(
            (n) =>
              n.netuid === event.netuid &&
              n.uid === event.uid &&
              n.hotkey === resolvedHotkey,
          );
        })
        .reduce((acc, event) => {
          const row = acc.get(event.netuid) ?? {
            netuid: event.netuid,
            weight_sets: 0,
            first_observed: event.observed_at,
            last_observed: event.observed_at,
          };
          row.weight_sets += 1;
          row.first_observed = Math.min(row.first_observed, event.observed_at);
          row.last_observed = Math.max(row.last_observed, event.observed_at);
          acc.set(event.netuid, row);
          return acc;
        }, new Map());
      return Array.from(grouped.values());
    };

    const { data, generatedAt } = await loadAccountWeightSetters(d1, ADDR, {
      windowLabel: "30d",
    });

    assert.equal(data.total_weight_sets, 4);
    assert.deepEqual(
      data.subnets.map((s) => [s.netuid, s.weight_sets]),
      [
        [7, 2],
        [9, 1],
        [11, 1],
      ],
    );
    assert.equal(generatedAt, new Date(now).toISOString());
  });

  test("an unknown window label falls back to the default window days", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [];
    };
    await loadAccountWeightSetters(d1, ADDR, { windowLabel: "bogus" });
    // 7d default cutoff = now - 7d; assert it's within a day of that.
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(captured.params[2] - expected) < 24 * 60 * 60 * 1000);
    assert.ok(Math.abs(captured.params[5] - expected) < 24 * 60 * 60 * 1000);
  });

  test("a cold store (no rows) yields a zeroed card + null generatedAt", async () => {
    const { data, generatedAt } = await loadAccountWeightSetters(
      async () => [],
      ADDR,
      { windowLabel: DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW },
    );
    assert.equal(data.total_weight_sets, 0);
    assert.equal(data.subnet_count, 0);
    assert.equal(generatedAt, null);
  });

  test("a non-array D1 result degrades to a zeroed card (never throws)", async () => {
    const { data, generatedAt } = await loadAccountWeightSetters(
      async () => null,
      ADDR,
      { windowLabel: "7d" },
    );
    assert.equal(data.total_weight_sets, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(generatedAt, null);
  });
});
