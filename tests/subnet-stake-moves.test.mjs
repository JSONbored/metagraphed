import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetStakeMoves,
  loadSubnetStakeMoves,
  STAKE_MOVED_EVENT_KIND,
  SUBNET_STAKE_MOVES_WINDOWS,
  DEFAULT_SUBNET_STAKE_MOVES_WINDOW,
} from "../src/subnet-stake-moves.ts";

describe("buildSubnetStakeMoves", () => {
  test("cold / null row yields a zeroed, schema-stable card", () => {
    for (const row of [null, undefined, {}]) {
      const d = buildSubnetStakeMoves(row, 7, { window: "7d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, 7);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_movers, 0);
      assert.equal(d.movements, 0);
      assert.equal(d.movements_per_mover, null); // no movers -> undefined intensity
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetStakeMoves({}, 7).window, null);
  });

  test("computes distinct movers, movement count, and movements-per-mover", () => {
    const d = buildSubnetStakeMoves(
      {
        distinct_movers: 4,
        movements: 40,
        newest_observed: 1750000000000,
      },
      7,
      { window: "30d" },
    );
    assert.equal(d.distinct_movers, 4);
    assert.equal(d.movements, 40);
    assert.equal(d.movements_per_mover, 10); // 40 / 4
    assert.equal(d.observed_at, new Date(1750000000000).toISOString());
  });

  test("rounds movements_per_mover to 2dp", () => {
    const d = buildSubnetStakeMoves({ distinct_movers: 3, movements: 40 }, 7);
    assert.equal(d.movements_per_mover, 13.33); // 40 / 3 = 13.333...
  });

  test("coerces a numeric-string observed_at and drops non-finite / out-of-range / <=0", () => {
    assert.equal(
      buildSubnetStakeMoves({ newest_observed: "1750000000000" }, 7)
        .observed_at,
      new Date(1750000000000).toISOString(),
    );
    for (const bad of [null, "", 0, -1, 9e15, "not-a-date"]) {
      assert.equal(
        buildSubnetStakeMoves({ newest_observed: bad }, 7).observed_at,
        null,
        `observed_at=${JSON.stringify(bad)}`,
      );
    }
  });

  test("coerces numeric-string counts and floors negatives / non-finite to 0", () => {
    const d = buildSubnetStakeMoves(
      { distinct_movers: "5", movements: "50" },
      7,
    );
    assert.equal(d.distinct_movers, 5);
    assert.equal(d.movements, 50);
    assert.equal(d.movements_per_mover, 10);
    const z = buildSubnetStakeMoves({ distinct_movers: -3, movements: "x" }, 7);
    assert.equal(z.distinct_movers, 0);
    assert.equal(z.movements, 0);
    assert.equal(z.movements_per_mover, null);
  });
});

describe("loadSubnetStakeMoves", () => {
  test("queries account_events for the netuid + StakeMoved over the window and shapes it", async () => {
    let captured;
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return [
        {
          distinct_movers: 2,
          movements: 20,
          newest_observed: 1750000000000,
        },
      ];
    };
    const d = await loadSubnetStakeMoves(d1, 7, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.match(captured.sql, /FROM account_events/);
    assert.match(captured.sql, /netuid = \?/);
    assert.match(captured.sql, /COUNT\(DISTINCT coldkey\)/);
    assert.equal(captured.params[0], 7);
    assert.equal(captured.params[1], STAKE_MOVED_EVENT_KIND);
    assert.equal(typeof captured.params[2], "number"); // cutoff epoch ms
    assert.equal(d.netuid, 7);
    assert.equal(d.window, "7d");
    assert.equal(d.movements, 20);
    assert.equal(d.movements_per_mover, 10);
  });

  test("a cold store (no rows) yields the zeroed card", async () => {
    const d = await loadSubnetStakeMoves(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(d.netuid, 9);
    assert.equal(d.movements, 0);
    assert.equal(d.movements_per_mover, null);
  });

  test("exposes the window map + default matching /chain/stake-moves", () => {
    assert.deepEqual(SUBNET_STAKE_MOVES_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_STAKE_MOVES_WINDOW, "7d");
  });
});
