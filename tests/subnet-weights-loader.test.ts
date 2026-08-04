// The per-subnet weights SUMMARY CARD, served from the lakehouse.
//
// Third instance of one shape. #9251 wired the chain-wide leaderboard, #9267 wired the
// per-subnet leaderboard, and the card those two drill into was left unwired by both —
// so it answered a confident 0 for every subnet on the network once the Postgres box
// went away. Measured live 2026-08-04:
//
//   GET /api/v1/subnets/64/weights/setters  distinct_setters 14, weight_sets 2750
//   GET /api/v1/subnets/64/weights          distinct_setters  0, weight_sets    0
//
// The properties worth pinning here are the two that make a wrong answer look right:
// the netuid filter (a per-subnet question answered by a chain-wide scan is plausible
// and wrong for every subnet but the busiest), and reading the WINDOW totals rather
// than a capped page.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSubnetWeightsColdTier } from "../src/subnet-weights-loader.ts";

type Row = Record<string, unknown>;

const ROWS = [
  { netuid: 7, uid: 3, weight_sets: 40, first_set: 1, last_set: 9 },
  { netuid: 7, uid: 5, weight_sets: 10, first_set: 2, last_set: 8 },
];
// Deliberately far larger than the rows sum (50). The card must report the WINDOW, and
// summing a capped page would under-report every busy subnet.
const TOTALS = { weight_sets: 2_750, newest_observed: 1_754_300_000_000 };
const DISTINCT = { distinct_setters: 14 };

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
  return { query, seen };
}

describe("loadSubnetWeightsColdTier", () => {
  test("reports the window totals, not the page sum", async () => {
    const engine = fakeEngine();
    const card = await loadSubnetWeightsColdTier({} as never, 7, {
      windowLabel: "7d",
      windowDays: 7,
      query: engine.query as never,
    });
    // The live SN64 reading its sibling already served, which this card reported as 0.
    assert.equal(card?.weight_sets, 2_750);
    assert.equal(card?.distinct_setters, 14);
    assert.notEqual(
      card?.weight_sets,
      50,
      "summed the capped page instead of the window",
    );
  });

  test("derives sets_per_setter from those totals", async () => {
    const engine = fakeEngine();
    const card = await loadSubnetWeightsColdTier({} as never, 7, {
      windowLabel: "7d",
      windowDays: 7,
      query: engine.query as never,
    });
    assert.equal(card?.sets_per_setter, 196.43);
  });

  test("narrows EVERY read to the requested subnet", async () => {
    // A chain-wide scan answering a per-subnet question is the failure that looks
    // plausible: right for the busiest subnet, wrong for all 127 others.
    const engine = fakeEngine();
    await loadSubnetWeightsColdTier({} as never, 7, {
      windowLabel: "7d",
      windowDays: 7,
      query: engine.query as never,
    });
    assert.ok(engine.seen.length > 0);
    for (const sql of engine.seen) {
      assert.match(sql, /netuid\s*=\s*7/, `unfiltered read: ${sql}`);
    }
  });

  test("netuid 0 is a real subnet, not an absent filter", async () => {
    const engine = fakeEngine();
    await loadSubnetWeightsColdTier({} as never, 0, {
      windowLabel: "7d",
      windowDays: 7,
      query: engine.query as never,
    });
    for (const sql of engine.seen) {
      assert.match(sql, /netuid\s*=\s*0/, `netuid 0 lost its filter: ${sql}`);
    }
  });

  test("carries the window label onto the card", async () => {
    const engine = fakeEngine();
    const card = await loadSubnetWeightsColdTier({} as never, 7, {
      windowLabel: "30d",
      windowDays: 30,
      query: engine.query as never,
    });
    assert.equal(card?.window, "30d");
  });

  test("declines rather than returning a zeroed card when a read misses", async () => {
    // Declining is what lets the caller tell "no activity" from "could not read" —
    // returning zeros here would reproduce the exact confident-zero bug this fixes.
    for (const missing of [
      { totals: null },
      { distinct: null },
      { rows: null },
    ]) {
      const engine = fakeEngine(missing);
      const card = await loadSubnetWeightsColdTier({} as never, 7, {
        windowLabel: "7d",
        windowDays: 7,
        query: engine.query as never,
      });
      assert.equal(
        card,
        null,
        `returned a card despite ${JSON.stringify(missing)}`,
      );
    }
  });

  test("an unusable netuid declines rather than scanning every subnet", async () => {
    const engine = fakeEngine();
    const card = await loadSubnetWeightsColdTier({} as never, Number.NaN, {
      windowLabel: "7d",
      windowDays: 7,
      query: engine.query as never,
    });
    assert.equal(card, null);
    assert.deepEqual(
      engine.seen,
      [],
      "scanned the lakehouse for a malformed netuid",
    );
  });

  test("a genuinely empty window still declines, so the caller owns the zero", async () => {
    const engine = fakeEngine({ rows: [] });
    const card = await loadSubnetWeightsColdTier({} as never, 7, {
      windowLabel: "7d",
      windowDays: 7,
      query: engine.query as never,
    });
    assert.equal(card, null);
  });
});
