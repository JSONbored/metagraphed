import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountStakeMoves,
  loadAccountStakeMoves,
  STAKE_MOVED_EVENT_KIND,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
} from "../src/account-stake-moves.ts";

function row(
  netuid: unknown,
  movements: unknown,
  first: number | null,
  last: number | null,
) {
  return {
    netuid,
    movements,
    first_observed: first,
    last_observed: last,
  };
}

const ADDR = "5GReferenceAccountAddressForStakeMovesTestsssss";

describe("buildAccountStakeMoves", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildAccountStakeMoves(rows, ADDR, { window: "30d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.address, ADDR);
      assert.equal(d.window, "30d");
      assert.equal(d.total_movements, 0);
      assert.equal(d.subnet_count, 0);
      assert.equal(d.concentration, null);
      assert.equal(d.dominant_netuid, null);
      assert.deepEqual(d.subnets, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildAccountStakeMoves([], ADDR).window, null);
  });

  test("folds per-subnet movement counts + first/last timestamps", () => {
    const d = buildAccountStakeMoves(
      [
        row(1, 3, 1_700_000_000_000, 1_700_500_000_000),
        row(7, 1, 1_700_100_000_000, 1_700_100_000_000),
      ],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.total_movements, 4);
    assert.equal(d.subnet_count, 2);
    assert.equal(d.subnets[0].netuid, 1);
    assert.equal(d.dominant_netuid, 1);
    const s1 = d.subnets.find((s) => s.netuid === 1)!;
    assert.equal(s1.movements, 3);
    assert.equal(s1.first_moved_at, new Date(1_700_000_000_000).toISOString());
    assert.equal(s1.last_moved_at, new Date(1_700_500_000_000).toISOString());
  });

  test("HHI concentration: all movements on one subnet -> 1, spread -> < 1", () => {
    const one = buildAccountStakeMoves([row(1, 5, 1000, 2000)], ADDR, {
      window: "7d",
    });
    assert.equal(one.concentration, 1);

    const split = buildAccountStakeMoves(
      [row(1, 3, 1000, 2000), row(2, 3, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(split.concentration, 0.5);
  });

  test("never rounds a sub-perfect concentration up to exactly 1", () => {
    const d = buildAccountStakeMoves(
      [row(1, 100000, 1000, 2000), row(2, 1, 1000, 2000)],
      ADDR,
      { window: "7d" },
    );
    assert.equal(d.concentration, 0.9999);
    assert.equal(d.subnet_count, 2);
  });

  test("ties on movement count break by netuid ascending", () => {
    const d = buildAccountStakeMoves(
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
    const d = buildAccountStakeMoves(
      [row(1, 2, 3000, 4000), row(1, 1, 1000, 3500), row(1, 1, 2000, 5000)],
      ADDR,
      { window: "30d" },
    );
    assert.equal(d.subnet_count, 1);
    const s = d.subnets[0];
    assert.equal(s.movements, 4);
    assert.equal(s.first_moved_at, new Date(1000).toISOString());
    assert.equal(s.last_moved_at, new Date(5000).toISOString());
  });

  test("skips malformed/blank/negative netuid and zero-count rows", () => {
    const d = buildAccountStakeMoves(
      [
        row(1, 4, 1000, 2000),
        { netuid: null, movements: 3 },
        { netuid: "", movements: 3 },
        { netuid: "bad", movements: 3 },
        { netuid: -1, movements: 3 },
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
    const d = buildAccountStakeMoves(
      [row(1, 2, 0, -5), row(2, 1, null, 9e15)],
      ADDR,
      { window: "7d" },
    );
    const s1 = d.subnets.find((s) => s.netuid === 1)!;
    assert.equal(s1.first_moved_at, null);
    assert.equal(s1.last_moved_at, null);
    const s2 = d.subnets.find((s) => s.netuid === 2)!;
    assert.equal(s2.first_moved_at, null);
    assert.equal(s2.last_moved_at, null);
  });

  describe("price-at-tx enrichment (#4332/6.3)", () => {
    test("attaches price_tao_at_last_move keyed by netuid + the last-move UTC date", () => {
      const lastMs = Date.UTC(2026, 5, 20, 12, 0, 0); // 2026-06-20T12:00:00Z
      const priceByNetuidDate = new Map([["1:2026-06-20", 4.5]]);
      const d = buildAccountStakeMoves([row(1, 3, lastMs, lastMs)], ADDR, {
        window: "7d",
        priceByNetuidDate,
      });
      assert.equal(d.subnets[0].price_tao_at_last_move, 4.5);
    });

    test("is null when no price was found for that (netuid, date)", () => {
      const lastMs = Date.UTC(2026, 5, 20, 12, 0, 0);
      const d = buildAccountStakeMoves([row(1, 3, lastMs, lastMs)], ADDR, {
        window: "7d",
        priceByNetuidDate: new Map(),
      });
      assert.equal(d.subnets[0].price_tao_at_last_move, null);
    });

    test("is null when priceByNetuidDate is omitted (backward-compatible default)", () => {
      const lastMs = Date.UTC(2026, 5, 20, 12, 0, 0);
      const d = buildAccountStakeMoves([row(1, 3, lastMs, lastMs)], ADDR, {
        window: "7d",
      });
      assert.equal(d.subnets[0].price_tao_at_last_move, null);
    });

    test("is null when the subnet has no last_moved_at (nothing to date the price against)", () => {
      const d = buildAccountStakeMoves([row(1, 2, null, null)], ADDR, {
        window: "7d",
        priceByNetuidDate: new Map([["1:2026-06-20", 4.5]]),
      });
      assert.equal(d.subnets[0].price_tao_at_last_move, null);
    });

    test("prices two subnets independently by their own last-move dates", () => {
      const dayOne = Date.UTC(2026, 5, 20, 0, 0, 0);
      const dayTwo = Date.UTC(2026, 5, 21, 0, 0, 0);
      const priceByNetuidDate = new Map([
        ["1:2026-06-20", 4.5],
        ["2:2026-06-21", 9.1],
      ]);
      const d = buildAccountStakeMoves(
        [row(1, 1, dayOne, dayOne), row(2, 1, dayTwo, dayTwo)],
        ADDR,
        { window: "7d", priceByNetuidDate },
      );
      const s1 = d.subnets.find((s) => s.netuid === 1)!;
      const s2 = d.subnets.find((s) => s.netuid === 2)!;
      assert.equal(s1.price_tao_at_last_move, 4.5);
      assert.equal(s2.price_tao_at_last_move, 9.1);
    });
  });
});

// A d1 runner that branches on the query: the stake-moves aggregate query
// returns `stakeMoveRows`, the follow-up alpha-price lookup returns
// `priceRows` — mirrors this session's sql.includes()-branching mock pattern
// for a runner now issuing two distinct queries.
function stakeMovesD1(
  stakeMoveRows: unknown,
  priceRows: unknown = [],
  calls: Array<{ sql: string; params: unknown[] }> = [],
) {
  return async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("FROM subnet_snapshots"))
      return priceRows as Record<string, unknown>[];
    return stakeMoveRows as Record<string, unknown>[];
  };
}

describe("loadAccountStakeMoves", () => {
  test("seeks the coldkey index for StakeMoved over the window and shapes it", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const d1 = stakeMovesD1(
      [
        row(1, 3, 1_700_000_000_000, 1_700_000_000_000),
        row(2, 1, 1_700_400_000_000, 1_700_500_000_000),
        row(3, 1, null, null),
      ],
      [],
      calls,
    );
    const { data, generatedAt } = await loadAccountStakeMoves(d1, ADDR, {
      windowLabel: "7d",
    });
    const stakeMovesCall = calls.find((c) =>
      c.sql.includes("FROM account_events"),
    )!;
    assert.match(
      stakeMovesCall.sql,
      /FROM account_events INDEXED BY idx_account_events_coldkey/,
    );
    assert.match(stakeMovesCall.sql, /WHERE coldkey = \? AND event_kind = \?/);
    assert.match(stakeMovesCall.sql, /GROUP BY netuid/);
    assert.equal(stakeMovesCall.params[0], ADDR);
    assert.equal(stakeMovesCall.params[1], STAKE_MOVED_EVENT_KIND);
    assert.equal(typeof stakeMovesCall.params[2], "number");
    assert.equal(data.total_movements, 5);
    assert.equal(generatedAt, new Date(1_700_500_000_000).toISOString());
  });

  test("an unknown window label falls back to the default window days", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const d1 = stakeMovesD1([], [], calls);
    await loadAccountStakeMoves(d1, ADDR, { windowLabel: "bogus" });
    const stakeMovesCall = calls.find((c) =>
      c.sql.includes("FROM account_events"),
    )!;
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    assert.ok(
      Math.abs((stakeMovesCall.params[2] as number) - expected) <
        24 * 60 * 60 * 1000,
    );
  });

  test("a cold store yields a zeroed card + null generatedAt", async () => {
    const { data, generatedAt } = await loadAccountStakeMoves(
      async () => [],
      ADDR,
      { windowLabel: DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW },
    );
    assert.equal(data.total_movements, 0);
    assert.equal(data.subnet_count, 0);
    assert.equal(generatedAt, null);
  });

  test("a non-array D1 result degrades to a zeroed card", async () => {
    const { data, generatedAt } = await loadAccountStakeMoves(
      async () => null as unknown as Record<string, unknown>[],
      ADDR,
      { windowLabel: "7d" },
    );
    assert.equal(data.total_movements, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(generatedAt, null);
  });

  describe("price-at-tx enrichment (#4332/6.3)", () => {
    test("issues a follow-up subnet_snapshots query keyed by netuid + last-move date and threads the price through", async () => {
      const lastMs = Date.UTC(2026, 5, 20, 12, 0, 0); // 2026-06-20
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const d1 = stakeMovesD1(
        [row(1, 3, lastMs, lastMs)],
        [{ netuid: 1, snapshot_date: "2026-06-20", alpha_price_tao: 4.5 }],
        calls,
      );
      const { data } = await loadAccountStakeMoves(d1, ADDR, {
        windowLabel: "7d",
      });
      const priceCall = calls.find((c) =>
        c.sql.includes("FROM subnet_snapshots"),
      )!;
      assert.match(priceCall.sql, /netuid IN \(\?\)/);
      assert.match(priceCall.sql, /snapshot_date IN \(\?\)/);
      assert.deepEqual(priceCall.params, [1, "2026-06-20"]);
      assert.equal(data.subnets[0].price_tao_at_last_move, 4.5);
    });

    test("batches multiple subnets into one follow-up query, not one per subnet", async () => {
      const dayOne = Date.UTC(2026, 5, 20, 0, 0, 0);
      const dayTwo = Date.UTC(2026, 5, 21, 0, 0, 0);
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const d1 = stakeMovesD1(
        [row(1, 1, dayOne, dayOne), row(2, 1, dayTwo, dayTwo)],
        [
          { netuid: 1, snapshot_date: "2026-06-20", alpha_price_tao: 4.5 },
          { netuid: 2, snapshot_date: "2026-06-21", alpha_price_tao: 9.1 },
        ],
        calls,
      );
      await loadAccountStakeMoves(d1, ADDR, { windowLabel: "7d" });
      const priceCalls = calls.filter((c) =>
        c.sql.includes("FROM subnet_snapshots"),
      );
      assert.equal(priceCalls.length, 1);
    });

    test("skips the follow-up query entirely when there are no stake-move rows (cold store)", async () => {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const d1 = stakeMovesD1([], [], calls);
      await loadAccountStakeMoves(d1, ADDR, { windowLabel: "7d" });
      assert.equal(
        calls.some((c) => c.sql.includes("FROM subnet_snapshots")),
        false,
      );
    });

    test("a null/blank/non-numeric alpha_price_tao cell is treated as no price, not zero", async () => {
      const lastMs = Date.UTC(2026, 5, 20, 0, 0, 0);
      for (const alpha_price_tao of [null, "", "   ", "not-a-number"]) {
        const d1 = stakeMovesD1(
          [row(1, 1, lastMs, lastMs)],
          [{ netuid: 1, snapshot_date: "2026-06-20", alpha_price_tao }],
        );
        const { data } = await loadAccountStakeMoves(d1, ADDR, {
          windowLabel: "7d",
        });
        assert.equal(
          data.subnets[0].price_tao_at_last_move,
          null,
          JSON.stringify(alpha_price_tao),
        );
      }
    });

    test("a non-array price-query result degrades to no prices found, not a throw", async () => {
      const lastMs = Date.UTC(2026, 5, 20, 0, 0, 0);
      const d1 = stakeMovesD1([row(1, 1, lastMs, lastMs)], null);
      const { data } = await loadAccountStakeMoves(d1, ADDR, {
        windowLabel: "7d",
      });
      assert.equal(data.subnets[0].price_tao_at_last_move, null);
    });

    test("no snapshot for that exact date leaves price_tao_at_last_move null", async () => {
      const lastMs = Date.UTC(2026, 5, 20, 0, 0, 0);
      const d1 = stakeMovesD1(
        [row(1, 1, lastMs, lastMs)],
        [], // no matching snapshot row at all
      );
      const { data } = await loadAccountStakeMoves(d1, ADDR, {
        windowLabel: "7d",
      });
      assert.equal(data.subnets[0].price_tao_at_last_move, null);
    });
  });
});
