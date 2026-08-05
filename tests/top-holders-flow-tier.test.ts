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

function artifact(rows: Array<Record<string, unknown>>) {
  return { schema_version: 1, generated_at: "x", row_count: rows.length, rows };
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
    for (const sort of ["total_tao", "free_tao", "delegated_tao", undefined]) {
      assert.equal(
        await loadTopHoldersFlowTier(env, { sort }),
        null,
        `${sort} is not a flow sort`,
      );
    }
    // And it declines BEFORE the get: a sort this tier cannot rank is not a
    // reason to spend an R2 round trip.
    assert.deepEqual(gets, []);
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
