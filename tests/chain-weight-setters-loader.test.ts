// The weight-setter leaderboard, served from the lakehouse (#9249).
//
// /api/v1/chain/weights/setters answered a stable zero while /chain/weights
// served 254 distinct setters and 65,043 weight sets from the SAME WeightsSet
// stream over the same window — #9237 gave the netuid rollup a reader and the
// setter leaderboard never got one.
//
// The trap this file pins: `account_events.hotkey` is NULL on every WeightsSet
// row, because the chain event emits [netuid, uid] and carries no hotkey. So
// the identity has to be `uid`, grouped WITHIN a netuid, and the published row
// must keep a null hotkey rather than inventing one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { loadChainWeightSettersColdTier } from "../src/chain-weight-setters-loader.ts";
import { loadChainEventIdentityRollup } from "../src/chain-event-rollup-cold-tier.ts";

type Row = Record<string, unknown>;

const NOW = 1_785_000_000_000;

/**
 * Rows whose weight_sets sum to 30, against ungrouped totals of 65,043.
 *
 * The gap is deliberate and is what the share denominator is checked against:
 * the row page is capped by `limit`, so a share computed from the page would
 * change with the page size. 65,043 is the real 7d figure from production.
 */
const ROWS = [
  {
    netuid: 1,
    uid: 7,
    weight_sets: 20,
    first_set: NOW - 600_000,
    last_set: NOW,
  },
  {
    netuid: 3,
    uid: 7,
    weight_sets: 10,
    first_set: NOW - 900_000,
    last_set: NOW,
  },
];
const TOTALS = { weight_sets: 65_043, newest_observed: NOW };
/**
 * The distinct count arrives from its own GROUP BY subquery, not from TOTALS.
 *
 * 1,284 is the real 7d figure measured against the lakehouse. The number the
 * ungrouped `count(DISTINCT uid)` used to return was 254 -- roughly the uid
 * ceiling, because it counted uid NUMBERS across all subnets instead of
 * (netuid, uid) participants. Keeping the two apart in the fixtures is what
 * makes a regression back to the collapsed count visible here.
 */
const DISTINCT = { distinct_setters: 1_284 };

/**
 * Answers all three halves of the rollup, and records the SQL.
 *
 * The discriminator is deliberately NOT "does it contain GROUP BY": the
 * distinct-pair query is a GROUP BY subquery too, so that test would have
 * silently answered the row fixture to two different questions. Each query is
 * selected on the clause only it can have -- `ORDER BY` for the ranked page,
 * `FROM (` for the subquery -- so a fixture can never drift onto the wrong one.
 */
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
    grouped: () => seen.find((sql) => sql.includes("ORDER BY"))!,
    distinct: () => seen.find((sql) => sql.includes("FROM ("))!,
    totals: () =>
      seen.find((sql) => !sql.includes("ORDER BY") && !sql.includes("FROM ("))!,
  };
}

describe("loadChainWeightSettersColdTier", () => {
  test("publishes (netuid, uid) identity with a null hotkey", async () => {
    // The event records no hotkey. Publishing one would be invented data, and
    // the builder's own fallback is netuid+uid precisely for this case.
    const engine = fakeEngine();
    const data = await loadChainWeightSettersColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query as never,
    });
    assert.ok(data);
    assert.equal(data.setter_count, 2);
    const [first] = data.setters;
    assert.equal(first.hotkey, null, "WeightsSet carries no hotkey");
    assert.equal(first.netuid, 1);
    assert.equal(first.uid, 7);
    assert.equal(first.weight_sets, 20);
  });

  test("groups on the pair, because a uid is only unique within a subnet", async () => {
    // Both fixture rows are uid 7 on different subnets. Grouping on uid alone
    // would merge two different neurons into one setter.
    const engine = fakeEngine();
    const data = await loadChainWeightSettersColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query as never,
    });
    assert.equal(
      data?.setter_count,
      2,
      "uid 7 on netuid 1 and 3 are not one setter",
    );
    assert.match(engine.grouped(), /GROUP BY netuid, uid/);
  });

  test("the share denominator is the window total, not the page sum", async () => {
    const engine = fakeEngine();
    const data = await loadChainWeightSettersColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query as never,
    });
    assert.equal(data?.weight_sets, 65_043);
    assert.equal(data?.distinct_setters, 1_284);
    // 20 / 65043, not 20 / 30.
    assert.ok(
      (data!.setters[0].share ?? 0) < 0.001,
      `share ${data!.setters[0].share} looks computed from the page (would be ~0.67)`,
    );
  });

  test("no query anywhere uses COUNT(DISTINCT)", async () => {
    // This is the bug that made the route serve zeros. R2 SQL REJECTS an
    // ungrouped count(DISTINCT) at this scale outright --
    //
    //   40015: scan budget exceeded: scanning too much data for
    //   count(DISTINCT) without GROUP BY
    //
    // -- and a rejected query makes the reader decline, so /chain/weights/
    // setters answered a stable 0 beside a sibling serving real numbers off
    // the same stream. The distinct count has to come from a GROUP BY
    // subquery, which is also the only form that counts the right thing.
    const engine = fakeEngine();
    await loadChainWeightSettersColdTier({} as never, {
      window: "30d",
      limit: 20,
      query: engine.query as never,
    });
    for (const sql of engine.seen) {
      assert.doesNotMatch(
        sql,
        /count\(\s*DISTINCT/i,
        `R2 SQL rejects this at production scale: ${sql}`,
      );
    }
  });

  test("counts distinct (netuid, uid) pairs, not distinct uid numbers", async () => {
    // A uid is unique only WITHIN a subnet, so counting uid alone collapses
    // uid 5 on twenty subnets into one and lands near the 256 uid ceiling
    // regardless of the truth -- it reported 254 against a real 1,284.
    const engine = fakeEngine();
    const data = await loadChainWeightSettersColdTier({} as never, {
      window: "7d",
      limit: 20,
      query: engine.query as never,
    });
    assert.equal(data?.distinct_setters, 1_284);
    assert.match(
      engine.distinct(),
      /FROM \(SELECT netuid, uid FROM chain\.account_events .*GROUP BY netuid, uid\)/,
      "the distinct count must group on the pair",
    );
  });

  test("declines with null when either half misses", async () => {
    for (const miss of [
      { rows: null },
      { totals: null },
      { distinct: null },
      { rows: [] },
      { distinct: [] },
    ]) {
      const engine = fakeEngine(miss);
      const data = await loadChainWeightSettersColdTier({} as never, {
        window: "7d",
        limit: 20,
        query: engine.query as never,
      });
      assert.equal(data, null, `${JSON.stringify(miss)} must decline`);
    }
  });

  test("an unknown window narrows to 7d rather than widening", async () => {
    const engine = fakeEngine();
    await loadChainWeightSettersColdTier({} as never, {
      window: "all-time",
      limit: 20,
      query: engine.query as never,
    });
    const cutoff = Number(/observed_at >= (\d+)/.exec(engine.grouped())![1]);
    const days = (Date.now() - cutoff) / 86_400_000;
    assert.ok(
      days > 6.9 && days < 7.1,
      `expected ~7d, got ${days.toFixed(2)}d`,
    );
  });
});

describe("all three weight-setter surfaces go through the one loader", () => {
  // The regression is a surface wired to the lakehouse while its siblings are
  // not -- which is exactly how this route came to answer zeros beside a
  // sibling serving 65,043 rows. A call site either exists or it does not, so
  // reading the sources asserts it exactly.
  const sources = {
    REST: "workers/request-handlers/analytics.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadChainWeightSettersColdTier", () => {
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadChainWeightSettersColdTier\(/,
        `${surface} (${path}) would answer the zeroed card while its siblings ` +
          "answer real numbers",
      );
    }
  });
});

// The reader's guards, exercised directly. They are unreachable through the
// loader above (it always passes CHAIN_WEIGHTS_ROLLUP and a validated window),
// but they are the injection defences: every identifier below lands in SQL
// IDENTIFIER position, where R2 SQL has no bound parameters to fall back on.
// Testing them beats marking them ignored -- an untested guard is a guard
// nobody knows still works.
describe("loadChainEventIdentityRollup guards", () => {
  const good = {
    eventKind: "WeightsSet",
    countField: "weight_sets",
    distinctField: "distinct_setters",
    distinctColumn: "uid",
  } as const;
  const engine = () => fakeEngine().query as never;

  test("refuses a spec whose identifiers are not safe in SQL", async () => {
    const bad = [
      { ...good, eventKind: "Weights; DROP TABLE x" },
      { ...good, countField: "weight_sets; --" },
      { ...good, distinctField: "SELECT 1" },
      // A real column name, but not one the table has.
      { ...good, distinctColumn: "coldkey" },
    ];
    for (const spec of bad) {
      assert.equal(
        await loadChainEventIdentityRollup({} as never, spec as never, {
          windowDays: 7,
          query: engine(),
        }),
        null,
        `${JSON.stringify(spec)} must be refused, not escaped`,
      );
    }
  });

  test("refuses a window that is not a positive finite number of days", async () => {
    for (const windowDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        await loadChainEventIdentityRollup({} as never, good, {
          windowDays,
          query: engine(),
        }),
        null,
        `windowDays ${windowDays} must be refused`,
      );
    }
  });

  test("refuses a window whose cutoff is not a usable timestamp", async () => {
    // A cutoff before the epoch is not a window the table can answer, and an
    // unsafe integer would be interpolated into SQL as an approximation.
    // 1_000: a cutoff before the epoch. 1e-9 days: a sub-millisecond window,
    // so the cutoff lands on a fraction — interpolating that into SQL would
    // ship an approximation of the boundary rather than the boundary.
    for (const [now, windowDays] of [
      [1_000, 7],
      [NOW, 1e-9],
    ] as const) {
      assert.equal(
        await loadChainEventIdentityRollup({} as never, good, {
          windowDays,
          now,
          query: engine(),
        }),
        null,
      );
    }
  });

  test("an unusable limit falls back to the default cap", async () => {
    for (const limit of [0, -5, 1.5, Number.NaN]) {
      const e = fakeEngine();
      await loadChainEventIdentityRollup({} as never, good, {
        windowDays: 7,
        limit,
        query: e.query as never,
      });
      assert.match(
        e.grouped(),
        /LIMIT 200/,
        `limit ${limit} should cap at 200`,
      );
    }
    // And an oversized one is clamped rather than honoured.
    const e = fakeEngine();
    await loadChainEventIdentityRollup({} as never, good, {
      windowDays: 7,
      limit: 99_999,
      query: e.query as never,
    });
    assert.match(e.grouped(), /LIMIT 1000/);
  });

  test("declines when the totals query returns no row at all", async () => {
    const e = fakeEngine({ totals: [] });
    assert.equal(
      await loadChainEventIdentityRollup({} as never, good, {
        windowDays: 7,
        query: e.query as never,
      }),
      null,
      "an empty totals result has no denominator to publish shares against",
    );
  });
});
