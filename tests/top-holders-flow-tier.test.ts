// The live net_flow_* leg of /api/v1/accounts/top-holders (#9469).
//
// THE BUG THIS FILE EXISTS FOR is not "the field was null" -- it is that the
// route answered `?sort=net_flow_30d` in LEXICOGRAPHIC ss58 order while
// echoing `"sort": "net_flow_30d"` back to the caller. Verified live on
// 2026-08-05: 5C4jr9g..., 5C4stSN..., 5C4zv89..., 5C523K1... Every row's flow
// cell was null, so compareTopHoldersSort put them all in the non-number
// bucket and fell through to its ss58 tie-break. So the assertions below check
// the ORDER, not merely that a number came back -- a non-null field with the
// wrong ranking is the exact failure that shipped.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildTopHoldersFlowRows,
  computeTopHoldersFlow,
  loadTopHoldersFlowTier,
  topHoldersFlowRows,
  topHoldersFlowSql,
  TOP_HOLDERS_FLOW_LANE,
  TOP_HOLDERS_FLOW_PROJECTION_KEY,
  TOP_HOLDERS_FLOW_SORTS,
  TOP_HOLDERS_FLOW_WINDOW_DAYS,
  TOP_HOLDERS_LIVE_SORTS,
  topHoldersArtifactSorts,
} from "../src/top-holders-flow-tier.ts";

const GENERATED_AT = Date.parse("2026-08-05T01:34:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** An aggregate row as the lakehouse hands it back. */
function aggregate(
  coldkey: string,
  flows: Partial<Record<string, number | null>>,
) {
  return { coldkey, ...flows };
}

function bucketWith(
  body: unknown,
  opts: { missing?: boolean; throws?: boolean } = {},
) {
  const gets: string[] = [];
  return {
    gets,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          gets.push(key);
          if (opts.throws) throw new Error("r2 unavailable");
          if (opts.missing) return null;
          return { json: async () => body };
        },
      },
    } as unknown as Env,
  };
}

/**
 * A holdings leg in the shape topHoldersHoldings returns.
 *
 * `sorts` defaults to whichever holdings columns the given cells actually
 * carry, which is the invariant the real leg maintains -- a leg that declared a
 * sort no row can rank would recreate the ss58-order defect this tier removes.
 */
function holdings(
  cells: Record<string, Record<string, number>>,
  sorts?: string[],
) {
  const entries = Object.entries(cells);
  return {
    cells: new Map(entries),
    sorts:
      sorts ??
      ["free_tao", "delegated_tao", "total_tao"].filter((key) =>
        entries.some(([, cell]) => typeof cell[key] === "number"),
      ),
  };
}

function artifact(
  rows: Array<Record<string, unknown>>,
  sorts: string[] = TOP_HOLDERS_FLOW_SORTS,
) {
  return {
    schema_version: 1,
    generated_at: "x",
    row_count: rows.length,
    sorts,
    rows,
  };
}

/**
 * A D1 stub whose one statement returns `rows` (or throws).
 *
 * Also answers the completeness probe (#9511), which runs BEFORE the balance
 * query: `topHoldersBalances` declines outright unless a pass has been recorded
 * complete, so a stub without it would make every balance test vacuously assert
 * the decline path. `pass` defaults to a completed one so the existing tests
 * keep testing what they were written to test; pass `null` for the ledger state
 * that must be refused.
 */
function d1With(
  rows: unknown[] | null,
  opts: {
    throws?: boolean;
    pass?: Record<string, unknown> | null;
  } = {},
) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const pass =
    opts.pass === undefined
      ? {
          captured_at: 1_785_900_000_000,
          expected_rows: 364_266,
          received_rows: 364_266,
        }
      : opts.pass;
  return {
    seen,
    env: {
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            // The completeness reader's shape.
            async first() {
              seen.push({ sql, params: [] });
              return pass;
            },
            // The holdings query binds NOTHING -- every value in it is a
            // constant or a number the module read out of D1 itself -- so the
            // stub has to answer at the statement, not only after bind().
            async all() {
              seen.push({ sql, params: [] });
              if (opts.throws) throw new Error("no such table");
              return rows === null ? null : { results: rows };
            },
            bind(...params: unknown[]) {
              return {
                async all() {
                  seen.push({ sql, params });
                  if (opts.throws) throw new Error("no such table");
                  return rows === null ? null : { results: rows };
                },
              };
            },
          };
        },
      },
    } as unknown as Env,
  };
}

describe("topHoldersFlowSql", () => {
  test("scans ONE window -- the widest -- and derives the rest from it", () => {
    const sql = topHoldersFlowSql(GENERATED_AT);
    const widest = GENERATED_AT - 90 * DAY_MS;
    // Exactly one lower bound on the scan itself: three separate window
    // queries would re-scan the same 1.65 GB of files three times over.
    assert.equal(
      (sql.match(/WHERE observed_at >= \d+/g) ?? []).length,
      1,
      "one scan predicate",
    );
    assert.ok(sql.includes(`WHERE observed_at >= ${widest}`));
    for (const key of TOP_HOLDERS_FLOW_SORTS) {
      const cutoff = GENERATED_AT - TOP_HOLDERS_FLOW_WINDOW_DAYS[key]! * DAY_MS;
      assert.ok(sql.includes(`AS ${key}`), `${key} projected`);
      assert.ok(
        sql.includes(`observed_at >= ${cutoff}`),
        `${key} narrows to its own cutoff`,
      );
    }
    assert.ok(sql.includes("GROUP BY coldkey"));
    // Not COUNT(DISTINCT ...): that is the aggregate R2 SQL refuses with
    // 40015, and avoiding it is why this runs at all.
    assert.ok(!/COUNT\s*\(\s*DISTINCT/i.test(sql));
  });

  test("interpolates only integers -- R2 SQL has no bound parameters", () => {
    const sql = topHoldersFlowSql(GENERATED_AT);
    // Every quoted literal is a module constant (the two event kinds), never
    // anything derived from a caller.
    assert.deepEqual(
      [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort(),
      [
        // one pair per window, plus the scan's own IN list
        ...TOP_HOLDERS_FLOW_SORTS.flatMap(() => ["StakeAdded", "StakeRemoved"]),
        "StakeAdded",
        "StakeRemoved",
      ].sort(),
    );
  });

  test("scopes to the requested chain's namespace", () => {
    assert.ok(topHoldersFlowSql(GENERATED_AT).includes("chain.account_events"));
    assert.ok(
      !topHoldersFlowSql(GENERATED_AT, "testnet").includes(
        " chain.account_events",
      ),
    );
  });
});

describe("buildTopHoldersFlowRows", () => {
  test("keeps the top N per sort key, as a union across keys", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5Top7", {
          net_flow_7d: 100,
          net_flow_30d: 1,
          net_flow_90d: 1,
        }),
        aggregate("5Top30", {
          net_flow_7d: 1,
          net_flow_30d: 100,
          net_flow_90d: 1,
        }),
        aggregate("5Top90", {
          net_flow_7d: 1,
          net_flow_30d: 1,
          net_flow_90d: 100,
        }),
        aggregate("5Never", {
          net_flow_7d: 0,
          net_flow_30d: 0,
          net_flow_90d: 0,
        }),
      ],
      GENERATED_AT,
      1,
    );
    // One row per key, unioned -- not one row total, and not all four.
    assert.deepEqual(rows.map((r) => r.ss58).sort(), [
      "5Top30",
      "5Top7",
      "5Top90",
    ]);
  });

  test("a coldkey whose every window is unreadable is dropped", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5Real", { net_flow_7d: 5 }),
        aggregate("5Junk", {
          net_flow_7d: null,
          net_flow_30d: Number.NaN,
          net_flow_90d: "",
        } as never),
      ],
      GENERATED_AT,
    );
    assert.deepEqual(
      rows.map((r) => r.ss58),
      ["5Real"],
    );
  });

  test("keeps a negative net flow -- an outflow is a measurement", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5Out", { net_flow_30d: -4_812.5 })],
      GENERATED_AT,
    );
    assert.equal(row!.net_flow_30d, -4_812.5);
  });

  test("carries no holdings columns, so the reader reports them as null", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5A", { net_flow_7d: 1 })],
      GENERATED_AT,
    );
    assert.equal("free_tao" in row!, false);
    assert.equal("delegated_tao" in row!, false);
    assert.equal(row!.captured_at, GENERATED_AT, "the LANE's stamp");
  });

  test("skips rows with no usable coldkey and tolerates a non-array input", () => {
    assert.deepEqual(buildTopHoldersFlowRows(null, GENERATED_AT), []);
    assert.deepEqual(
      buildTopHoldersFlowRows(
        [
          { coldkey: "", net_flow_7d: 1 },
          { coldkey: 7, net_flow_7d: 1 },
          {},
        ] as never,
        GENERATED_AT,
      ),
      [],
    );
  });

  test("is address-ordered, so two runs over the same accounts are byte-stable", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5C", { net_flow_7d: 1 }),
        aggregate("5A", { net_flow_7d: 3 }),
        aggregate("5B", { net_flow_7d: 2 }),
      ],
      GENERATED_AT,
    );
    assert.deepEqual(
      rows.map((r) => r.ss58),
      ["5A", "5B", "5C"],
    );
  });

  // The free_tao and net_flow populations are DISJOINT in production -- the
  // top free-balance accounts hold 5.4M TAO and delegate nothing -- so the
  // union has to keep both, not intersect them.
  test("unions the balance leaderboard with the flow one", () => {
    const rows = buildTopHoldersFlowRows(
      [aggregate("5Staker", { net_flow_7d: 500 })],
      GENERATED_AT,
      1,
      holdings({ "5Exchange": { free_tao: 5_448_995.869289362 } }),
    );
    assert.deepEqual(rows.map((r) => r.ss58).sort(), ["5Exchange", "5Staker"]);
    const exchange = rows.find((r) => r.ss58 === "5Exchange")!;
    assert.equal(exchange.free_tao, 5_448_995.869289362);
    // An account ranked only by balance has no flow figures, and says so with
    // absence rather than a zero.
    assert.equal("net_flow_7d" in exchange, false);
  });

  test("merges both legs onto one row when an account appears in each", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5Both", { net_flow_30d: -12 })],
      GENERATED_AT,
      10,
      holdings({ "5Both": { free_tao: 42, delegated_tao: 8, total_tao: 50 } }),
    );
    assert.equal(row!.free_tao, 42);
    assert.equal(row!.delegated_tao, 8);
    assert.equal(row!.total_tao, 50);
    assert.equal(row!.net_flow_30d, -12);
    assert.equal(row!.captured_at, GENERATED_AT);
  });

  // Each holdings column becomes provable on its own day: free_tao needs a
  // complete account_balances pass, delegated_tao a complete hotkey_alpha one.
  // A leg proving only one must rank only that one.
  test("ranks only the holdings sorts the leg proved", () => {
    const rows = buildTopHoldersFlowRows(
      [aggregate("5Flow", { net_flow_7d: 1 })],
      GENERATED_AT,
      1,
      holdings({
        "5Pool": { delegated_tao: 81_185 },
        "5Tiny": { delegated_tao: 1 },
      }),
    );
    // delegated_tao ranked, so the larger of the two survives the cap of 1.
    assert.ok(rows.some((r) => r.ss58 === "5Pool"));
    assert.equal(
      rows.some((r) => r.ss58 === "5Tiny"),
      false,
    );
    // free_tao and total_tao were never proven, so no row carries either.
    assert.equal(
      JSON.stringify(rows).includes("free_tao"),
      false,
      "no free_tao column while its ledger is unproven",
    );
    assert.equal(JSON.stringify(rows).includes("total_tao"), false);
  });

  test("a null holdings leg leaves every holdings column out entirely", () => {
    const [row] = buildTopHoldersFlowRows(
      [aggregate("5A", { net_flow_7d: 1 })],
      GENERATED_AT,
      10,
      null,
    );
    assert.equal("free_tao" in row!, false);
    assert.equal("delegated_tao" in row!, false);
    assert.equal("total_tao" in row!, false);
  });

  test("ties inside a capped key break on ss58, not on insertion order", () => {
    const rows = buildTopHoldersFlowRows(
      [
        aggregate("5B", { net_flow_7d: 9 }),
        aggregate("5A", { net_flow_7d: 9 }),
      ],
      GENERATED_AT,
      1,
    );
    assert.deepEqual(
      rows.map((r) => r.ss58),
      ["5A"],
    );
  });
});

describe("topHoldersArtifactSorts", () => {
  // A body written by the flow-only lane (#9492) has no `sorts`. Reading it as
  // flow-only is what keeps a deploy landing before the next 01:34 tick
  // answering exactly what it answered yesterday.
  test("a body with no `sorts` is read as flow-only", () => {
    assert.deepEqual(topHoldersArtifactSorts({}), TOP_HOLDERS_FLOW_SORTS);
    assert.deepEqual(topHoldersArtifactSorts(null), TOP_HOLDERS_FLOW_SORTS);
  });

  test("a declared list is honoured, and unrecognised entries are dropped", () => {
    assert.deepEqual(
      topHoldersArtifactSorts({ sorts: ["free_tao", "net_flow_7d"] }),
      ["free_tao", "net_flow_7d"],
    );
    // Never rank on whatever a stored string asks for. total_tao IS a live
    // sort now (#9502), so the example has to be something no leg can ever
    // back -- otherwise this stops testing the drop.
    assert.deepEqual(
      topHoldersArtifactSorts({ sorts: ["reserved_tao", 7, null] }),
      [],
    );
    assert.deepEqual(
      topHoldersArtifactSorts({ sorts: ["total_tao", "made_up"] }),
      ["total_tao"],
    );
  });
});

describe("computeTopHoldersFlow", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("declines when the lakehouse cannot answer, leaving the previous ranking", async () => {
    // No R2_SQL_TOKEN -> r2SqlQuery returns null -> null body -> the runner
    // writes nothing. A blank artifact would be worse than yesterday's.
    assert.equal(await computeTopHoldersFlow({} as never), null);
  });

  test("shapes an answered scan into the artifact the reader accepts", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            rows: [
              {
                coldkey: "5A",
                net_flow_7d: 2,
                net_flow_30d: 5,
                net_flow_90d: 9,
              },
            ],
          },
          success: true,
        }),
        { headers: { "content-type": "application/json" } },
      )) as never;
    const body = (await computeTopHoldersFlow({
      R2_SQL_TOKEN: "cfut_test",
    } as unknown as Env)) as Record<string, unknown>;
    assert.equal(body.schema_version, 1);
    assert.equal(body.row_count, 1);
    assert.ok(topHoldersFlowRows(body), "readable by the reader's own test");
    assert.ok(Date.parse(body.generated_at as string) > 0);
  });

  test("declares only the sorts the legs actually backed", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: { rows: [{ coldkey: "5A", net_flow_7d: 1 }] },
          success: true,
        }),
        { headers: { "content-type": "application/json" } },
      )) as never;
    // No D1 binding -> the holdings leg declines entirely -> none of the three
    // is claimed, and the frozen artifact keeps those sorts.
    const withoutHoldings = (await computeTopHoldersFlow({
      R2_SQL_TOKEN: "cfut_test",
    } as unknown as Env)) as Record<string, unknown>;
    assert.deepEqual(withoutHoldings.sorts, TOP_HOLDERS_FLOW_SORTS);

    const withHoldings = (await computeTopHoldersFlow({
      R2_SQL_TOKEN: "cfut_test",
      ...(d1With([
        {
          ss58: "5Exchange",
          free_tao: 900,
          delegated_tao: 100,
          total_tao: 1_000,
        },
      ]).env as object),
    } as unknown as Env)) as Record<string, unknown>;
    assert.deepEqual(withHoldings.sorts, TOP_HOLDERS_LIVE_SORTS);
    assert.equal(withHoldings.row_count, 2);

    // A leg that proved only ONE column declares only that one: the artifact
    // must never claim a sort no row in it can rank.
    const partial = (await computeTopHoldersFlow({
      R2_SQL_TOKEN: "cfut_test",
      ...(d1With([{ ss58: "5Exchange", free_tao: 900 }]).env as object),
    } as unknown as Env)) as Record<string, unknown>;
    assert.deepEqual(partial.sorts, [...TOP_HOLDERS_FLOW_SORTS, "free_tao"]);
  });

  // The balance ledger is mainnet-only. Reading it for a testnet projection
  // would label another chain's accounts with finney balances.
  test("never reads the mainnet balance ledger for a testnet projection", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: { rows: [{ coldkey: "5A", net_flow_7d: 1 }] },
          success: true,
        }),
        { headers: { "content-type": "application/json" } },
      )) as never;
    const { env, seen } = d1With([{ ss58: "5Exchange", free_tao: 900 }]);
    const body = (await computeTopHoldersFlow(
      { R2_SQL_TOKEN: "cfut_test", ...(env as object) } as unknown as Env,
      "testnet",
    )) as Record<string, unknown>;
    assert.deepEqual(body.sorts, TOP_HOLDERS_FLOW_SORTS);
    assert.deepEqual(seen, [], "the balance ledger must not be queried at all");
  });

  test("the lane declares the key the reader gets", () => {
    assert.equal(
      TOP_HOLDERS_FLOW_LANE.artifactKey,
      TOP_HOLDERS_FLOW_PROJECTION_KEY,
    );
    assert.equal(TOP_HOLDERS_FLOW_LANE.name, "top-holders-flow");
    assert.equal(TOP_HOLDERS_FLOW_LANE.compute, computeTopHoldersFlow);
  });
});

describe("topHoldersFlowRows", () => {
  test("declines a body that is not the artifact the lane wrote", () => {
    assert.equal(topHoldersFlowRows(null), null);
    assert.equal(topHoldersFlowRows({ schema_version: 2, rows: [] }), null);
    assert.equal(topHoldersFlowRows({ schema_version: 1 }), null);
    assert.deepEqual(topHoldersFlowRows({ schema_version: 1, rows: [] }), []);
  });
});

describe("loadTopHoldersFlowTier", () => {
  // THE REGRESSION TEST. Not "net_flow_30d is non-null" -- the ORDER.
  test("returns a real net-flow ranking, not ss58 order", async () => {
    // Deliberately arranged so the two orders disagree: the biggest inflow has
    // the LAST address alphabetically, and the artifact is stored in address
    // order the way the lane writes it.
    const { env } = bucketWith(
      artifact([
        { ss58: "5Aaa", net_flow_30d: -900, captured_at: GENERATED_AT },
        { ss58: "5Mmm", net_flow_30d: 12, captured_at: GENERATED_AT },
        { ss58: "5Zzz", net_flow_30d: 5_000, captured_at: GENERATED_AT },
      ]),
    );
    const data = (await loadTopHoldersFlowTier(env, {
      sort: "net_flow_30d",
      limit: 10,
    }))!;
    assert.deepEqual(
      (data.accounts as { ss58: string }[]).map((a) => a.ss58),
      ["5Zzz", "5Mmm", "5Aaa"],
      "ranked by flow, descending -- ss58 order would be 5Aaa,5Mmm,5Zzz",
    );
    assert.equal(data.sort, "net_flow_30d");
    // And captured_at ADVANCES: the whole complaint was a timestamp that could
    // not move off 2026-08-02.
    assert.equal(data.captured_at, new Date(GENERATED_AT).toISOString());
  });

  test("reports the holdings columns as null rather than zero", async () => {
    const { env } = bucketWith(
      artifact([{ ss58: "5A", net_flow_7d: 3, captured_at: GENERATED_AT }]),
    );
    const data = (await loadTopHoldersFlowTier(env, { sort: "net_flow_7d" }))!;
    const [account] = data.accounts as Record<string, unknown>[];
    assert.equal(account!.free_tao, null);
    assert.equal(account!.delegated_tao, null);
    assert.equal(account!.total_tao, null);
    assert.equal(account!.net_flow_7d, 3);
  });

  test("declines every sort it cannot rank, so the frozen artifact answers", async () => {
    const { env, gets } = bucketWith(
      artifact([{ ss58: "5A", net_flow_7d: 3, captured_at: GENERATED_AT }]),
    );
    // Every holdings sort CAN now be live (#9502), so none of them is rejected
    // up front any more -- they are rejected per-body, by the artifact's own
    // `sorts`. What remains a cheap up-front rejection is a sort no version of
    // this artifact could ever carry.
    for (const sort of ["reserved_tao", undefined]) {
      assert.equal(
        await loadTopHoldersFlowTier(env, { sort }),
        null,
        `${sort} can never be a live sort`,
      );
    }
    // And it declines BEFORE the get: a sort no version of this artifact can
    // rank is not a reason to spend an R2 round trip.
    assert.deepEqual(gets, []);

    // The holdings sorts do spend the round trip, and then decline on a
    // flow-only body rather than ranking rows that have no such column.
    for (const sort of ["total_tao", "delegated_tao", "free_tao"]) {
      assert.equal(await loadTopHoldersFlowTier(env, { sort }), null, sort);
    }
    assert.equal(gets.length, 3, "one get per per-body rejection");
  });

  // The switch that makes the free_tao cutover deploy-free: the same code
  // declines or answers purely on what the written object says it ranked.
  test("answers free_tao only when the artifact declares it", async () => {
    const rows = [
      { ss58: "5Small", free_tao: 1, captured_at: GENERATED_AT },
      { ss58: "5Exchange", free_tao: 5_448_995, captured_at: GENERATED_AT },
    ];
    assert.equal(
      await loadTopHoldersFlowTier(bucketWith(artifact(rows)).env, {
        sort: "free_tao",
      }),
      null,
      "flow-only artifact must not rank a column it did not compose",
    );
    const data = (await loadTopHoldersFlowTier(
      bucketWith(artifact(rows, TOP_HOLDERS_LIVE_SORTS)).env,
      { sort: "free_tao", limit: 10 },
    ))!;
    assert.deepEqual(
      (data.accounts as { ss58: string }[]).map((a) => a.ss58),
      ["5Exchange", "5Small"],
    );
  });

  test("never ranks a sort no live leg can back, even if the body claims it", async () => {
    // The artifact is ours, but a reader that ranks on whatever a stored
    // string asks for is one bad write away from a confident nonsense
    // ordering. `reserved_tao` is a real column name on account_balances and
    // is NOT a live sort, which is what makes it the right probe here.
    const { env } = bucketWith(
      artifact(
        [{ ss58: "5A", free_tao: 1, captured_at: GENERATED_AT }],
        ["reserved_tao", "made_up"],
      ),
    );
    for (const sort of ["reserved_tao", "made_up"]) {
      assert.equal(await loadTopHoldersFlowTier(env, { sort }), null);
    }
    // And a body claiming a sort it carries no values for still declines,
    // rather than ranking every row into compareTopHoldersSort's non-number
    // bucket and answering in ss58 order -- the defect this tier removes.
    const claimed = bucketWith(
      artifact(
        [{ ss58: "5A", free_tao: 1, captured_at: GENERATED_AT }],
        ["total_tao"],
      ),
    );
    const ranked = await loadTopHoldersFlowTier(claimed.env, {
      sort: "total_tao",
    });
    assert.equal(
      (ranked?.accounts as Record<string, unknown>[])?.[0]?.total_tao ?? null,
      null,
    );
  });

  test("reads the projection key, not the frozen one", async () => {
    const { env, gets } = bucketWith(
      artifact([{ ss58: "5A", net_flow_7d: 1, captured_at: GENERATED_AT }]),
    );
    await loadTopHoldersFlowTier(env, { sort: "net_flow_7d" });
    assert.deepEqual(gets, [TOP_HOLDERS_FLOW_PROJECTION_KEY]);
  });

  test("declines on an unbound bucket, a missing object, a throw, a foreign body and an empty one", async () => {
    const q = { sort: "net_flow_90d" };
    assert.equal(await loadTopHoldersFlowTier(null, q), null);
    assert.equal(await loadTopHoldersFlowTier({} as never, q), null);
    assert.equal(
      await loadTopHoldersFlowTier(bucketWith(null, { missing: true }).env, q),
      null,
    );
    assert.equal(
      await loadTopHoldersFlowTier(bucketWith(null, { throws: true }).env, q),
      null,
    );
    assert.equal(
      await loadTopHoldersFlowTier(bucketWith({ schema_version: 9 }).env, q),
      null,
    );
    // An emptied-in-place artifact declines too: the frozen leaderboard is a
    // better answer than an empty page, and this is also the pre-first-run
    // state.
    assert.equal(
      await loadTopHoldersFlowTier(bucketWith(artifact([])).env, q),
      null,
    );
  });

  test("honours the caller's limit as a prefix of the same ranking", async () => {
    const { env } = bucketWith(
      artifact([
        { ss58: "5A", net_flow_90d: 1, captured_at: GENERATED_AT },
        { ss58: "5B", net_flow_90d: 3, captured_at: GENERATED_AT },
        { ss58: "5C", net_flow_90d: 2, captured_at: GENERATED_AT },
      ]),
    );
    const data = (await loadTopHoldersFlowTier(env, {
      sort: "net_flow_90d",
      limit: 2,
    }))!;
    assert.equal(data.account_count, 3, "the count covers the whole ranking");
    assert.deepEqual(
      (data.accounts as { ss58: string }[]).map((a) => a.ss58),
      ["5B", "5C"],
    );
  });
});

describe("the flow lane's cron", () => {
  // Two silent wiring failures this repo has hit before: a cron constant with
  // no wrangler entry never fires, and a cron with no dispatch branch falls
  // through to the health prober.
  test("is daily, unique here, and present in wrangler.jsonc", async () => {
    const config = (await import("../workers/config.ts")) as Record<
      string,
      unknown
    >;
    const cron = config.TOP_HOLDERS_FLOW_CRON as string;
    const others = Object.entries(config)
      .filter(
        ([name]) => name.endsWith("_CRON") && name !== "TOP_HOLDERS_FLOW_CRON",
      )
      .map(([, value]) => value);
    assert.equal(others.includes(cron), false, "dispatch keys on the literal");
    // Daily: a fixed minute AND a fixed hour, which is what makes 1.65 GB per
    // scan cost 1.65 GB a day rather than 79.
    assert.match(cron, /^\d+ \d+ \* \* \*$/);

    const { readFile } = await import("node:fs/promises");
    const wrangler = await readFile("wrangler.jsonc", "utf8");
    assert.ok(
      wrangler.includes(`"${cron}"`),
      "must have a triggers.crons entry",
    );
  });

  test("handleScheduled routes it to the lane, not the health prober", async () => {
    const { handleScheduled } = await import("../workers/api.ts");
    const { TOP_HOLDERS_FLOW_CRON } = await import("../workers/config.ts");
    const puts: string[] = [];
    const result = (await handleScheduled(
      { cron: TOP_HOLDERS_FLOW_CRON } as never,
      {
        METAGRAPH_ARCHIVE: {
          async put(key: string) {
            puts.push(key);
          },
        },
      } as never,
      {} as never,
    )) as Record<string, unknown>;
    // No R2 SQL configured here, so the compute declines and NOTHING is
    // written -- the all-or-nothing posture that keeps yesterday's ranking.
    assert.equal(result.name, "top-holders-flow");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "compute_declined");
    assert.deepEqual(puts, []);
  });
});
