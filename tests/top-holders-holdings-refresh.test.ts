// The three-hourly holdings refresh (#9632).
//
// EVERY TEST HERE IS ABOUT ONE OF TWO FAILURES, because a bug in this lane is
// never a crash:
//
//   1. It publishes a WORSE artifact than the one already there. The lane
//      rewrites the object the route serves, so any path that drops the flow
//      ranking, drops a holdings column, or invents a row set replaces a
//      correct leaderboard with a plausible wrong one and reports success.
//   2. It publishes a FRESHER-LOOKING artifact than the data justifies.
//      `generated_at` is what the staleness watchdog bounds; advancing it here
//      would make a dead daily lane read healthy forever.
//
// The decline cases are therefore not error handling -- they are the contract.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  computeTopHoldersHoldingsRefresh,
  publishedFlowGeneratedAt,
  TOP_HOLDERS_HOLDINGS_REFRESH_LANE,
  topHoldersFlowCellsFromRows,
} from "../src/top-holders-holdings-refresh.ts";
import {
  TOP_HOLDERS_FLOW_PROJECTION_KEY,
  TOP_HOLDERS_HOLDINGS_SORTS,
  topHoldersArtifactSorts,
} from "../src/top-holders-flow-tier.ts";
import type { HoldingsLeg } from "../src/top-holders-holdings.ts";
import { TOP_HOLDERS_HOLDINGS_SORT_VALUES } from "../schemas-src/routes/top-holders.ts";
import { buildTopHoldersList } from "../src/top-holders.ts";
import {
  TOP_HOLDERS_FLOW_CRON,
  TOP_HOLDERS_HOLDINGS_REFRESH_CRON,
} from "../workers/config.ts";

/** The published flow vintage: 01:34 UTC, the daily lane's slot. */
const FLOW_AT = "2026-08-15T01:34:47.000Z";
/** The newest COMPLETE account_balances pass at refresh time -- the real one
 * from 2026-08-15, which is what makes the numbers below the measured ones. */
const BALANCES_AT = Date.parse("2026-08-15T07:44:48.000Z");
/** When the refresh lane ran. Deliberately hours after BALANCES_AT: the whole
 * point of the row stamp is that it reports the DATA's age, not the lane's. */
const REFRESH_AT = Date.parse("2026-08-15T12:49:00.000Z");

/** The headline account from the issue, at both vintages. */
const TOP = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const SERVED_FREE = 5_403_692.792802455;
const LIVE_FREE = 5_404_484.759152642;

function leg(
  cells: Record<string, Record<string, number>>,
  sorts?: string[],
  capturedAt = BALANCES_AT,
): HoldingsLeg {
  const entries = Object.entries(cells);
  return {
    cells: new Map(entries),
    capturedAt,
    sorts:
      sorts ??
      ["free_tao", "delegated_tao", "total_tao"].filter((key) =>
        entries.some(([, cell]) => typeof cell[key] === "number"),
      ),
  };
}

/** The artifact as the daily lane wrote it this morning. */
function publishedBody(
  rows: unknown[] = [
    {
      ss58: TOP,
      net_flow_7d: -1_200.5,
      net_flow_30d: 4_000,
      net_flow_90d: 9_000,
      free_tao: SERVED_FREE,
      delegated_tao: 10,
      total_tao: SERVED_FREE + 10,
      captured_at: Date.parse(FLOW_AT),
      holdings_captured_at: Date.parse(FLOW_AT),
    },
  ],
  extra: Record<string, unknown> = {},
) {
  return {
    schema_version: 1,
    generated_at: FLOW_AT,
    row_count: rows.length,
    sorts: ["net_flow_7d", "net_flow_30d", "net_flow_90d", "free_tao"],
    rows,
    ...extra,
  };
}

function envWith(
  body: unknown,
  opts: { missing?: boolean; throwOnGet?: boolean; throwOnJson?: boolean } = {},
) {
  return {
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        assert.equal(key, TOP_HOLDERS_FLOW_PROJECTION_KEY);
        if (opts.throwOnGet) throw new Error("r2 unreachable");
        if (opts.missing) return null;
        return {
          async json() {
            if (opts.throwOnJson) throw new Error("not json");
            return body;
          },
        };
      },
    },
  } as unknown as Env;
}

function refresh(
  env: Env,
  holdings: HoldingsLeg | null,
  network?: Parameters<typeof computeTopHoldersHoldingsRefresh>[1],
) {
  return computeTopHoldersHoldingsRefresh(env, network, {
    holdings: async () => holdings,
    now: () => REFRESH_AT,
  });
}

describe("topHoldersFlowCellsFromRows", () => {
  // The rename is the bug this function exists to prevent, and it fails
  // SILENTLY: buildTopHoldersFlowRows reads `coldkey` and writes `ss58`, so
  // feeding written rows straight back drops every one on the `!coldkey`
  // guard and publishes a holdings-only artifact with three un-ranked sorts.
  test("renames ss58 back to coldkey", () => {
    const [cells] = topHoldersFlowCellsFromRows([
      { ss58: "5A", net_flow_7d: 3 },
    ]);
    assert.equal(cells!.coldkey, "5A");
    assert.equal("ss58" in cells!, false);
  });

  // The stale holdings values must NOT ride along. If they did, a column the
  // fresh leg declined would survive as yesterday's number under today's
  // stamp -- the one shape worse than declining the column outright.
  test("carries the flow cells and nothing else", () => {
    const [cells] = topHoldersFlowCellsFromRows([
      {
        ss58: "5A",
        net_flow_7d: 1,
        net_flow_30d: 2,
        net_flow_90d: 3,
        free_tao: 999,
        total_tao: 999,
        captured_at: 1,
        holdings_captured_at: 2,
      },
    ]);
    assert.deepEqual(cells, {
      coldkey: "5A",
      net_flow_7d: 1,
      net_flow_30d: 2,
      net_flow_90d: 3,
    });
  });

  test("drops rows with no usable ss58, and non-numeric flow cells", () => {
    assert.deepEqual(
      topHoldersFlowCellsFromRows([
        { ss58: 17, net_flow_7d: 1 },
        { net_flow_7d: 1 },
        { ss58: "", net_flow_7d: 1 },
        { ss58: "5A", net_flow_7d: "3" },
      ]),
      [{ coldkey: "5A" }],
    );
  });
});

describe("publishedFlowGeneratedAt", () => {
  test("returns the string as written alongside the parsed instant", () => {
    assert.deepEqual(publishedFlowGeneratedAt({ generated_at: FLOW_AT }), {
      iso: FLOW_AT,
      ms: Date.parse(FLOW_AT),
    });
    // A microsecond fraction is what the flow lane's own fixtures carry, and
    // it must survive verbatim rather than being normalised on the way through.
    const micro = "2026-08-02T22:38:17.501738+00:00";
    assert.equal(publishedFlowGeneratedAt({ generated_at: micro })?.iso, micro);
  });

  test("a missing, non-string or unparseable stamp is a decline", () => {
    for (const body of [
      null,
      {},
      { generated_at: 17 },
      { generated_at: "not a timestamp" },
    ]) {
      assert.equal(publishedFlowGeneratedAt(body), null, JSON.stringify(body));
    }
  });
});

describe("computeTopHoldersHoldingsRefresh", () => {
  test("republishes the holdings columns and leaves the flow ones alone", async () => {
    const body = await refresh(
      envWith(publishedBody()),
      leg({
        [TOP]: {
          free_tao: LIVE_FREE,
          delegated_tao: 12,
          total_tao: LIVE_FREE + 12,
        },
      }),
    );
    assert.ok(body);
    const [row] = body.rows as Record<string, unknown>[];
    // The measured drift from the issue, now gone.
    assert.equal(row!.free_tao, LIVE_FREE);
    assert.equal(row!.delegated_tao, 12);
    // Every flow cell survives, values AND vintage.
    assert.equal(row!.net_flow_7d, -1_200.5);
    assert.equal(row!.net_flow_30d, 4_000);
    assert.equal(row!.net_flow_90d, 9_000);
    assert.equal(row!.captured_at, Date.parse(FLOW_AT));
  });

  // The #2 failure at the top of this file. `generated_at` is the field the
  // staleness watchdog bounds; if this lane advanced it, a daily lane that
  // stopped running would read healthy for as long as the refresh kept ticking.
  test("carries generated_at forward verbatim and never advances it", async () => {
    const body = await refresh(
      envWith(publishedBody()),
      leg({ [TOP]: { free_tao: LIVE_FREE } }),
    );
    assert.equal(body!.generated_at, FLOW_AT);
    assert.equal(
      body!.holdings_generated_at,
      new Date(REFRESH_AT).toISOString(),
    );
  });

  // The row stamp is the DATA's age, not the lane's. A lane-clock stamp would
  // have announced these numbers as 0 minutes old when the balance scan behind
  // them was already five hours stale.
  test("stamps rows with the input pass, not the refresh clock", async () => {
    const body = await refresh(
      envWith(publishedBody()),
      leg({ [TOP]: { free_tao: LIVE_FREE } }),
    );
    const [row] = body!.rows as Record<string, unknown>[];
    assert.equal(row!.holdings_captured_at, BALANCES_AT);
    assert.notEqual(row!.holdings_captured_at, REFRESH_AT);
  });

  // A column the fresh leg could not prove must vanish, not persist at
  // yesterday's value: `sorts` is what the reader trusts, so a surviving cell
  // under a dropped sort is a number nothing will ever correct.
  test("a column the fresh leg declined does not survive from the old body", async () => {
    const body = await refresh(
      envWith(publishedBody()),
      leg({ [TOP]: { free_tao: LIVE_FREE } }, ["free_tao"]),
    );
    const [row] = body!.rows as Record<string, unknown>[];
    assert.equal(row!.free_tao, LIVE_FREE);
    assert.equal("delegated_tao" in row!, false);
    assert.equal("total_tao" in row!, false);
    assert.deepEqual(body!.sorts, [
      "net_flow_7d",
      "net_flow_30d",
      "net_flow_90d",
      "free_tao",
    ]);
  });

  // An account the flow scan never saw still belongs on a holdings-ranked page
  // -- the leg picks its own top-N over the full store tables, so the row set
  // is not capped by the stale flow one.
  test("an account only the holdings leg names is added", async () => {
    const body = await refresh(
      envWith(publishedBody()),
      leg({ "5Exchange": { free_tao: 900_000 } }),
    );
    const names = (body!.rows as Record<string, unknown>[]).map((r) => r.ss58);
    assert.ok(names.includes("5Exchange"));
    assert.ok(names.includes(TOP), "the flow-ranked row is still there");
  });

  test("the row set is not capped by the previous artifact's holdings", async () => {
    const body = await refresh(
      envWith(publishedBody()),
      leg({
        "5A": { free_tao: 3 },
        "5B": { free_tao: 2 },
        "5C": { free_tao: 1 },
      }),
    );
    assert.equal(body!.row_count, 4);
  });

  describe("declines, which all leave the published artifact in place", () => {
    const holdings = () => leg({ [TOP]: { free_tao: LIVE_FREE } });

    test("on a network other than mainnet", async () => {
      assert.equal(
        await refresh(envWith(publishedBody()), holdings(), "testnet"),
        null,
      );
    });

    test("without a bucket binding", async () => {
      assert.equal(await refresh({} as Env, holdings()), null);
      assert.equal(
        await refresh({ METAGRAPH_ARCHIVE: {} } as unknown as Env, holdings()),
        null,
      );
    });

    // THE ONE THAT MATTERS MOST. A refresh must never be able to CREATE the
    // leaderboard: with no flow scan behind it, the body it would write has no
    // net_flow_* ranking at all, so three sorts would go from live to declined
    // and the watchdog would report a lane that had just written.
    test("when there is no artifact yet", async () => {
      assert.equal(
        await refresh(envWith(undefined, { missing: true }), holdings()),
        null,
      );
    });

    test("when the get or the parse throws", async () => {
      assert.equal(
        await refresh(envWith(undefined, { throwOnGet: true }), holdings()),
        null,
      );
      assert.equal(
        await refresh(envWith(undefined, { throwOnJson: true }), holdings()),
        null,
      );
    });

    // Judged by the READ PATH's own test. A body this lane accepted and the
    // route rejects would be rewritten under a fresh stamp and still serve an
    // empty leaderboard -- with the watchdog now calling it healthy.
    test("on a body the route itself would not serve", async () => {
      for (const bad of [
        { schema_version: 2, generated_at: FLOW_AT, rows: [{ ss58: "5A" }] },
        { schema_version: 1, generated_at: FLOW_AT, rows: "nope" },
        { schema_version: 1, generated_at: FLOW_AT, rows: [] },
      ]) {
        assert.equal(await refresh(envWith(bad), holdings()), null);
      }
    });

    test("when the published body cannot say how old its flow half is", async () => {
      const body = publishedBody();
      assert.equal(
        await refresh(
          envWith({ ...body, generated_at: undefined }),
          holdings(),
        ),
        null,
      );
    });

    // Rewriting WITHOUT the holdings columns would drop three live sorts to
    // make a stamp move -- strictly worse than the object already published.
    test("when the holdings leg proves nothing", async () => {
      assert.equal(await refresh(envWith(publishedBody()), null), null);
    });

    // A published body whose rows carry no readable flow cell projects to
    // nothing, and the merge would then publish holdings-only rows under a
    // `sorts` list claiming three flow rankings.
    test("when the merge would produce no rows at all", async () => {
      const body = publishedBody([{ ss58: TOP, free_tao: 1, captured_at: 1 }]);
      assert.equal(
        await refresh(envWith(body), {
          cells: new Map(),
          sorts: ["free_tao"],
          capturedAt: BALANCES_AT,
        }),
        null,
      );
    });
  });

  // The seams have real defaults, and a test that only ever injects never
  // proves it: an unwired `deps.holdings` would read as a permanent decline in
  // production and as a passing suite here.
  describe("the injected seams default to the real ones", () => {
    test("with no holdings dep it calls the store leg, which declines unbound", async () => {
      assert.equal(
        await computeTopHoldersHoldingsRefresh(
          envWith(publishedBody()),
          undefined,
          { now: () => REFRESH_AT },
        ),
        null,
      );
    });

    test("with no clock dep it stamps from the real one", async () => {
      const before = Date.now();
      const body = await computeTopHoldersHoldingsRefresh(
        envWith(publishedBody()),
        undefined,
        { holdings: async () => leg({ [TOP]: { free_tao: LIVE_FREE } }) },
      );
      const at = Date.parse(body!.holdings_generated_at as string);
      assert.ok(
        at >= before && at <= Date.now(),
        String(body!.holdings_generated_at),
      );
    });
  });

  // The reader is unchanged by this lane, which is the design: one artifact,
  // two writers. If the refreshed body did not satisfy the same reader, the
  // route would decline every sort the moment a refresh landed.
  test("the refreshed body still reads back through the served reader", async () => {
    const body = await refresh(
      envWith(publishedBody()),
      leg({
        [TOP]: {
          free_tao: LIVE_FREE,
          delegated_tao: 12,
          total_tao: LIVE_FREE + 12,
        },
      }),
    );
    assert.deepEqual(topHoldersArtifactSorts(body), [
      "net_flow_7d",
      "net_flow_30d",
      "net_flow_90d",
      "free_tao",
      "delegated_tao",
      "total_tao",
    ]);
    // And the two vintages reach the envelope: a holdings-sorted page reports
    // the balance pass, a flow-sorted page reports the daily scan.
    const rows = body!.rows as Record<string, unknown>[];
    assert.equal(
      buildTopHoldersList(rows, { sort: "total_tao" }).captured_at,
      new Date(BALANCES_AT).toISOString(),
    );
    assert.equal(
      buildTopHoldersList(rows, { sort: "net_flow_30d" }).captured_at,
      FLOW_AT,
    );
  });
});

describe("the lane and its cron", () => {
  test("writes the SAME key the flow lane writes", () => {
    assert.equal(
      TOP_HOLDERS_HOLDINGS_REFRESH_LANE.artifactKey,
      TOP_HOLDERS_FLOW_PROJECTION_KEY,
    );
    assert.equal(
      TOP_HOLDERS_HOLDINGS_REFRESH_LANE.name,
      "top-holders-holdings-refresh",
    );
  });

  // Two silent wiring failures this repo has hit before: a cron constant with
  // no wrangler entry never fires, and a cron whose literal collides with
  // another's routes one lane's tick into the other's branch.
  test("has its own cron string, registered in wrangler.jsonc", async () => {
    const config = (await import("../workers/config.ts")) as Record<
      string,
      unknown
    >;
    const others = Object.entries(config)
      .filter(
        ([name]) =>
          name.endsWith("_CRON") &&
          name !== "TOP_HOLDERS_HOLDINGS_REFRESH_CRON",
      )
      .map(([, value]) => value);
    assert.equal(
      others.includes(TOP_HOLDERS_HOLDINGS_REFRESH_CRON),
      false,
      "dispatch keys on the literal",
    );
    assert.notEqual(TOP_HOLDERS_HOLDINGS_REFRESH_CRON, TOP_HOLDERS_FLOW_CRON);
    // Three-hourly on a fixed minute: faster than the six-hourly producer it
    // consumes, so the phase between them cannot cost a full producer interval.
    assert.match(TOP_HOLDERS_HOLDINGS_REFRESH_CRON, /^\d+ \*\/3 \* \* \*$/);

    const { readFile } = await import("node:fs/promises");
    const wrangler = await readFile("wrangler.jsonc", "utf8");
    assert.ok(
      wrangler.includes(`"${TOP_HOLDERS_HOLDINGS_REFRESH_CRON}"`),
      "the cron constant must match a triggers.crons entry",
    );
  });

  test("handleScheduled routes it to the lane, not the health prober", async () => {
    const { handleScheduled } = await import("../workers/api.ts");
    const puts: string[] = [];
    const result = (await handleScheduled(
      { cron: TOP_HOLDERS_HOLDINGS_REFRESH_CRON } as never,
      {
        METAGRAPH_ARCHIVE: {
          async get() {
            return null;
          },
          async put(key: string) {
            puts.push(key);
          },
        },
      } as never,
      {} as never,
    )) as Record<string, unknown>;
    // No published artifact here, so the compute declines and NOTHING is
    // written -- the all-or-nothing posture that keeps the existing object.
    assert.equal(result.name, "top-holders-holdings-refresh");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "compute_declined");
    assert.deepEqual(puts, []);
  });
});

// The copy that exists so the row formatter does not have to import the
// Postgres read path. tests/read-store-tables-match-the-sql.test.ts is the
// same idea for a different copy: state it once, then pin it.
describe("the holdings sort list is single-sourced in effect", () => {
  test("the schema's partition matches the lane's own three constants", () => {
    assert.deepEqual(
      [...TOP_HOLDERS_HOLDINGS_SORT_VALUES].sort(),
      [...TOP_HOLDERS_HOLDINGS_SORTS].sort(),
    );
  });
});
