// The per-subnet weight-setter leaderboard, served from the lakehouse (#9267).
//
// #9251 fixed the chain-wide leaderboard; this route is a separate set of call
// sites and kept answering the zeroed card from the same WeightsSet stream —
// the same "one surface wired, its sibling not" shape, one level down.
//
// The property this file exists for is the netuid filter: a per-subnet question
// answered by a chain-wide scan would look plausible and be wrong for every
// subnet but the busiest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { loadSubnetWeightSettersColdTier } from "../src/subnet-weight-setters-loader.ts";

type Row = Record<string, unknown>;

const ROWS = [
  { netuid: 7, uid: 3, weight_sets: 40, first_set: 1, last_set: 9 },
  { netuid: 7, uid: 5, weight_sets: 10, first_set: 2, last_set: 8 },
];
// Deliberately larger than the rows sum (50): the page is capped, so a share
// computed from it would grow as the page shrank.
const TOTALS = { weight_sets: 5_000, newest_observed: 9 };
/** The distinct count comes from its own GROUP BY subquery, not from TOTALS --
 * an ungrouped COUNT(DISTINCT) is both rejected by the engine at scale and
 * counts uid NUMBERS rather than (netuid, uid) participants. Kept in a separate
 * fixture so a regression back to the collapsed count is visible here. */
const DISTINCT = { distinct_setters: 61 };

/** Selects each read on the clause only it can have -- the distinct query is a
 * GROUP BY subquery too, so discriminating on "GROUP BY" alone would answer the
 * row fixture to two different questions. */
function fakeEngine(
  overrides: {
    rows?: Row[] | null;
    totals?: Row[] | null;
    distinct?: Row[] | null;
  } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (sql.includes("ORDER BY")) return pick(overrides.rows, ROWS);
    if (sql.includes("FROM (")) return pick(overrides.distinct, [DISTINCT]);
    return pick(overrides.totals, [TOTALS]);
  };
  return {
    query,
    seen,
    grouped: () => seen.find((s) => s.includes("ORDER BY"))!,
  };
}

describe("loadSubnetWeightSettersColdTier", () => {
  test("narrows EVERY read to the requested subnet", async () => {
    // Not just the leaderboard. A chain-wide totals or distinct read would
    // publish a denominator from every subnet, making each setter's share look
    // tiny and the participant count wrong.
    const engine = fakeEngine();
    await loadSubnetWeightSettersColdTier({} as never, 7, {
      windowDays: 7,
      windowLabel: "7d",
      query: engine.query as never,
    });
    assert.equal(engine.seen.length, 3, "rows, totals and the distinct pair");
    for (const sql of engine.seen) {
      assert.match(sql, /AND netuid = 7/, `unscoped read: ${sql.slice(0, 80)}`);
    }
  });

  test("publishes uid identity with a null hotkey", async () => {
    const engine = fakeEngine();
    const data = await loadSubnetWeightSettersColdTier({} as never, 7, {
      windowDays: 7,
      windowLabel: "7d",
      query: engine.query as never,
    });
    assert.ok(data);
    const [first] = data.setters as Array<Row>;
    assert.equal(first.hotkey, null, "WeightsSet carries no hotkey");
    assert.equal(first.uid, 3);
    assert.equal(first.weight_sets, 40);
  });

  test("the share denominator is the window total, not the page sum", async () => {
    const engine = fakeEngine();
    const data = await loadSubnetWeightSettersColdTier({} as never, 7, {
      windowDays: 7,
      windowLabel: "7d",
      query: engine.query as never,
    });
    assert.equal((data as Row).weight_sets, 5_000);
    assert.equal((data as Row).distinct_setters, 61);
    // 40 / 5000 = 0.008, not 40 / 50 = 0.8.
    const share = ((data!.setters as Array<Row>)[0].share ?? 0) as number;
    assert.ok(share < 0.05, `share ${share} looks computed from the page`);
  });

  test("an unusable netuid declines rather than scanning every subnet", async () => {
    for (const netuid of [-1, 1.5, Number.NaN]) {
      const engine = fakeEngine();
      assert.equal(
        await loadSubnetWeightSettersColdTier({} as never, netuid, {
          windowDays: 7,
          query: engine.query as never,
        }),
        null,
        `netuid ${netuid} must decline`,
      );
      assert.equal(engine.seen.length, 0, "must not reach the engine");
    }
  });

  test("declines when either half misses", async () => {
    for (const miss of [
      { rows: null },
      { totals: null },
      { distinct: null },
      { rows: [] },
      { distinct: [] },
    ]) {
      const engine = fakeEngine(miss);
      assert.equal(
        await loadSubnetWeightSettersColdTier({} as never, 7, {
          windowDays: 7,
          query: engine.query as never,
        }),
        null,
        `${JSON.stringify(miss)} must decline`,
      );
    }
  });

  test("netuid 0 is a real subnet, not an absent filter", async () => {
    // A falsy-check on netuid would silently widen root's leaderboard to the
    // whole chain.
    const engine = fakeEngine();
    await loadSubnetWeightSettersColdTier({} as never, 0, {
      windowDays: 7,
      query: engine.query as never,
    });
    assert.match(engine.grouped(), /AND netuid = 0/);
  });
});

describe("all three subnet weight-setter surfaces go through the one loader", () => {
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadSubnetWeightSettersColdTier", () => {
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadSubnetWeightSettersColdTier\(/,
        `${surface} (${path}) would keep answering the zeroed card`,
      );
    }
  });
});
