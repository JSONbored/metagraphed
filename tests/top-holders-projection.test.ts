// The top-holders recompute lane (#9469).
//
// The lane exists because every column the leaderboard publishes had lost its
// producer: `free_tao` had no sink at all until #9483, and `net_flow_*` read a
// `wallet_flow_daily` rollup that exists only in prose. What is pinned here is
// mostly REFUSAL -- the lane's most important behaviour is declining to publish
// a leaderboard that is missing free balances, because that would reorder the
// ranking rather than merely age it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildTopHoldersProjectionRows,
  computeTopHolders,
  runTopHoldersRecompute,
  safeSs58,
  TOP_HOLDERS_ARTIFACT_KEY,
  TOP_HOLDERS_PROJECTION_ROW_LIMIT,
  type D1Runner,
} from "../src/top-holders-projection.ts";
import { buildTopHoldersList } from "../src/top-holders.ts";
import { TOP_HOLDERS_RECOMPUTE_CRON } from "../workers/config.ts";

const WHALE = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const DELEGATOR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const MOVER = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const AT = 1_785_900_000_000;

describe("buildTopHoldersProjectionRows", () => {
  // The original query was a FULL OUTER JOIN: an account with only delegated
  // stake is a real holder, and so is one that only moved stake this week.
  test("an account from any single source still appears", () => {
    const rows = buildTopHoldersProjectionRows({
      balances: new Map([[WHALE, { freeTao: 100, capturedAt: AT }]]),
      delegated: new Map([[DELEGATOR, 50]]),
      netFlow: new Map([[MOVER, { 7: -5 }]]),
    });
    assert.deepEqual(
      rows.map((r) => r.ss58).sort(),
      [WHALE, DELEGATOR, MOVER].sort(),
    );
  });

  test("a missing net-flow window stays null rather than becoming zero", () => {
    // The published contract: null means "no flow row in the window", which is
    // a different claim from a confirmed zero mover, and sorts last.
    const [row] = buildTopHoldersProjectionRows({
      balances: new Map([[WHALE, { freeTao: 1, capturedAt: AT }]]),
      delegated: new Map(),
      netFlow: new Map([[WHALE, { 7: 0 }]]),
    });
    assert.equal(row!.net_flow_7d, 0, "a real zero survives as zero");
    assert.equal(row!.net_flow_30d, null);
    assert.equal(row!.net_flow_90d, null);
  });

  test("a negative net flow is preserved -- it is a real outflow", () => {
    const [row] = buildTopHoldersProjectionRows({
      balances: new Map([[WHALE, { freeTao: 1, capturedAt: AT }]]),
      delegated: new Map(),
      netFlow: new Map([[WHALE, { 7: -42.5, 30: -100, 90: 7 }]]),
    });
    assert.equal(row!.net_flow_7d, -42.5);
    assert.equal(row!.net_flow_30d, -100);
  });

  // captured_at is what the route republishes as the leaderboard's own stamp,
  // so it must be the BALANCE capture -- the one input that is a point-in-time
  // state read rather than a rolling window.
  test("captured_at comes from the balance read, and is null without one", () => {
    const rows = buildTopHoldersProjectionRows({
      balances: new Map([[WHALE, { freeTao: 1, capturedAt: AT }]]),
      delegated: new Map([[DELEGATOR, 9]]),
      netFlow: new Map(),
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.ss58, r]));
    assert.equal(byKey[WHALE]!.captured_at, AT);
    assert.equal(byKey[DELEGATOR]!.captured_at, null);
  });

  // The reader is unchanged by this lane, so the rows it emits must be exactly
  // what buildTopHoldersList already consumes.
  test("the rows feed the existing formatter unchanged", () => {
    const rows = buildTopHoldersProjectionRows({
      balances: new Map([
        [WHALE, { freeTao: 100, capturedAt: AT }],
        [DELEGATOR, { freeTao: 1, capturedAt: AT }],
      ]),
      delegated: new Map([[DELEGATOR, 500]]),
      netFlow: new Map([[WHALE, { 7: -5, 30: -5, 90: -5 }]]),
    });
    const page = buildTopHoldersList(rows, { sort: "total_tao", limit: 10 });
    assert.equal(page.account_count, 2);
    // DELEGATOR: 1 + 500 outranks WHALE: 100 + 0 on total_tao.
    assert.equal(
      (page.accounts as Record<string, unknown>[])[0]!.ss58,
      DELEGATOR,
    );
    assert.equal(page.captured_at, new Date(AT).toISOString());
  });
});

describe("safeSs58", () => {
  test("accepts real addresses and rejects anything SQL-unsafe", () => {
    assert.equal(safeSs58(WHALE), WHALE);
    for (const bad of [
      "",
      null,
      undefined,
      42,
      "5Whale'); DROP TABLE account_balances;--",
      "has space",
      "0OIl_notbase58",
      "x".repeat(65),
    ]) {
      assert.equal(safeSs58(bad), null, String(bad));
    }
  });
});

/** A D1 runner answering each query by matching a fragment of its SQL. */
function d1With(
  answers: { match: string; rows: Record<string, unknown>[] | null }[],
): { d1: D1Runner; seen: string[] } {
  const seen: string[] = [];
  const d1: D1Runner = async (sql) => {
    seen.push(sql);
    for (const { match, rows } of answers) {
      if (sql.includes(match)) return rows;
    }
    return [];
  };
  return { d1, seen };
}

const HOLDINGS_SQL = "FROM account_balances ab";
const DELEGATED_SQL = "ORDER BY delegated_tao";
const FILL_SQL = "WHERE ss58 IN";

describe("computeTopHolders", () => {
  const env = {} as never;

  test("declines on a cold balance tier rather than publishing zeros", async () => {
    // THE case this lane's decline exists for. free_tao dominates total_tao for
    // exactly the accounts a top-holder list is about, so an empty balance
    // table would reorder the ranking and drop real whales off it.
    const { d1 } = d1With([{ match: HOLDINGS_SQL, rows: [] }]);
    assert.equal(await computeTopHolders(env, "mainnet", { d1 }), null);
  });

  test("declines on any failed HOLDINGS read", async () => {
    for (const match of [HOLDINGS_SQL, DELEGATED_SQL]) {
      const { d1 } = d1With([
        // The override goes FIRST -- d1With answers with the first match.
        { match, rows: null },
        {
          match: HOLDINGS_SQL,
          rows: [
            { ss58: WHALE, free_tao: 1, captured_at: AT, delegated_tao: 0 },
          ],
        },
      ]);
      assert.equal(
        await computeTopHolders(env, "mainnet", { d1 }),
        null,
        match,
      );
    }
  });

  // The D1 tiers it reads are single mainnet tables with no network column, so
  // a testnet tick would read mainnet holdings and publish them under a
  // testnet key.
  test("declines on any non-mainnet network", async () => {
    const { d1, seen } = d1With([]);
    assert.equal(await computeTopHolders(env, "testnet", { d1 }), null);
    assert.deepEqual(seen, [], "must not even query on testnet");
  });

  // Net flow is a SECONDARY sort key, null for every account in the artifact
  // this replaces. Declining the whole leaderboard -- and leaving free_tao
  // stale another six hours -- over it would be the worse trade.
  test("an unreadable lakehouse degrades net flow instead of declining", async () => {
    const { d1 } = d1With([
      {
        match: HOLDINGS_SQL,
        rows: [
          { ss58: WHALE, free_tao: 10, captured_at: AT, delegated_tao: 2 },
        ],
      },
      { match: DELEGATED_SQL, rows: [] },
    ]);
    // env has no R2 SQL configured, so loadNetFlowByColdkey declines.
    const body = (await computeTopHolders(env, "mainnet", {
      d1,
      now: () => AT,
    })) as Record<string, unknown>;
    assert.notEqual(body, null, "holdings alone must still publish");
    assert.equal(body.net_flow_available, false);
    const rows = body.rows as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.free_tao, 10, "the holdings are real");
    assert.equal(rows[0]!.net_flow_7d, null);
  });

  test("declines when D1 is unbound", async () => {
    assert.equal(await computeTopHolders({} as never, "mainnet"), null);
  });
});

describe("runTopHoldersRecompute", () => {
  function bucketStub() {
    const puts: { key: string; body: string }[] = [];
    return {
      puts,
      env: {
        METAGRAPH_ARCHIVE: {
          async put(key: string, body: string) {
            puts.push({ key, body });
          },
        },
      } as never,
    };
  }

  test("refuses before querying when R2 is unbound", async () => {
    assert.deepEqual(await runTopHoldersRecompute({} as never), {
      ok: false,
      reason: "r2_binding_missing",
    });
  });

  // A decline is the expected state until the poller redeploys, and the
  // top-holders staleness watchdog already reports this artifact's age on its
  // own cron -- a second alarm for one condition is how a channel stops being
  // read.
  test("a decline writes nothing and raises no exception", async () => {
    const { puts, env } = bucketStub();
    const events: unknown[] = [];
    const { d1 } = d1With([{ match: HOLDINGS_SQL, rows: [] }]);
    const result = await runTopHoldersRecompute(env, {
      d1,
      recordException: (async (_e: unknown, ev: unknown) => {
        events.push(ev);
        return true;
      }) as never,
    });
    assert.deepEqual(result, { ok: false, reason: "compute_declined" });
    assert.deepEqual(puts, [], "the previous artifact must survive");
    assert.deepEqual(events, [], "the watchdog owns this alarm, not the lane");
  });

  test("a thrown compute is reported, not swallowed", async () => {
    const { env } = bucketStub();
    const events: { errorCode?: string; route?: string }[] = [];
    const d1: D1Runner = async () => {
      throw new Error("d1 exploded");
    };
    const result = await runTopHoldersRecompute(env, {
      d1,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    });
    assert.deepEqual(result, { ok: false, reason: "compute_failed" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.route, "projection:top-holders");
    assert.equal(events[0]!.errorCode, "compute_failed");
  });

  test("a failed write is reported and never reads as success", async () => {
    const events: { errorCode?: string }[] = [];
    const env = {
      METAGRAPH_ARCHIVE: {
        async put() {
          throw new Error("r2 down");
        },
      },
    } as never;
    const { d1 } = d1With([
      {
        match: HOLDINGS_SQL,
        rows: [
          { ss58: WHALE, free_tao: 10, captured_at: AT, delegated_tao: 2 },
        ],
      },
      { match: DELEGATED_SQL, rows: [] },
    ]);
    const result = await runTopHoldersRecompute(env, {
      d1,
      now: () => AT,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    });
    assert.deepEqual(result, { ok: false, reason: "write_failed" });
    // The degraded-net-flow note fires first in this env (no R2 SQL); the
    // write failure is the one that decides the verdict.
    assert.equal(events.at(-1)!.errorCode, "write_failed");
  });

  test("a degraded publish reports why net flow is null", async () => {
    const { puts, env } = bucketStub();
    const events: { errorCode?: string }[] = [];
    const { d1 } = d1With([
      {
        match: HOLDINGS_SQL,
        rows: [
          { ss58: WHALE, free_tao: 10, captured_at: AT, delegated_tao: 0 },
        ],
      },
      { match: DELEGATED_SQL, rows: [] },
    ]);
    const result = (await runTopHoldersRecompute(env, {
      d1,
      now: () => AT,
      recordException: (async (_e: unknown, ev: never) => {
        events.push(ev);
        return true;
      }) as never,
    })) as Record<string, unknown>;
    // It PUBLISHED -- holdings are live -- and it said why net flow is null,
    // which is otherwise indistinguishable from "nobody moved any stake".
    assert.equal(result.ok, true);
    assert.equal(puts.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.errorCode, "net_flow_unavailable");
  });

  test("a complete answer overwrites the artifact the reader already serves", async () => {
    const { puts, env } = bucketStub();
    const { d1 } = d1With([
      {
        match: HOLDINGS_SQL,
        rows: [
          { ss58: WHALE, free_tao: 5_000, captured_at: AT, delegated_tao: 0 },
        ],
      },
      { match: DELEGATED_SQL, rows: [{ ss58: DELEGATOR, delegated_tao: 900 }] },
      { match: FILL_SQL, rows: [] },
    ]);
    const result = (await runTopHoldersRecompute(env, {
      d1,
      now: () => AT,
      recordException: (async () => true) as never,
    })) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(puts.length, 1);
    // The SAME key src/top-holders-artifact.ts reads -- the handover the
    // frozen artifact's own header anticipated.
    assert.equal(puts[0]!.key, TOP_HOLDERS_ARTIFACT_KEY);
    const body = JSON.parse(puts[0]!.body);
    assert.equal(body.schema_version, 1, "the reader declines any other value");
    assert.ok(Array.isArray(body.rows));
    assert.equal(body.generated_at, new Date(AT).toISOString());
    // And the artifact the reader would now serve is a real leaderboard.
    const page = buildTopHoldersList(body.rows, { limit: 10 });
    assert.equal(page.account_count, 2);
  });
});

describe("the recompute cron", () => {
  test("is unique, six-hourly, and off the */5 and */15 grids", async () => {
    const config = (await import("../workers/config.ts")) as Record<
      string,
      unknown
    >;
    const others = Object.entries(config)
      .filter(
        ([k, v]) =>
          k.endsWith("_CRON") &&
          k !== "TOP_HOLDERS_RECOMPUTE_CRON" &&
          typeof v === "string",
      )
      .map(([, v]) => v);
    assert.ok(!others.includes(TOP_HOLDERS_RECOMPUTE_CRON));
    const [minute, hour] = TOP_HOLDERS_RECOMPUTE_CRON.split(" ");
    assert.equal(hour, "*/6", "cadence follows the poller's 6h balance tick");
    const m = Number(minute);
    assert.notEqual(m % 5, 0);
    assert.notEqual(m % 15, 0);
    // Minute-level collision with another trigger is what the config comments
    // ask each new cron to avoid.
    const takenMinutes = others.flatMap((c) =>
      String(c)
        .split(" ")[0]!
        .split(",")
        .filter((p) => /^\d+$/.test(p)),
    );
    assert.ok(
      !takenMinutes.includes(minute!),
      `minute ${minute} already carries another trigger`,
    );
  });

  test("wrangler.jsonc declares the trigger", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    )
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(raw) as { triggers?: { crons?: string[] } };
    assert.ok(
      parsed.triggers?.crons?.includes(TOP_HOLDERS_RECOMPUTE_CRON),
      `wrangler.jsonc must fire ${TOP_HOLDERS_RECOMPUTE_CRON}`,
    );
  });

  test("handleScheduled dispatches to the recompute", async () => {
    const { handleScheduled } = await import("../workers/api.ts");
    const result = (await handleScheduled(
      { cron: TOP_HOLDERS_RECOMPUTE_CRON } as never,
      {} as never,
      {} as never,
    )) as Record<string, unknown>;
    // No R2 binding in this env, so the branch is proven by its own refusal --
    // which no other cron branch returns.
    assert.deepEqual(result, { ok: false, reason: "r2_binding_missing" });
  });
});

describe("the row budget", () => {
  test("clears the route's own published maximum with headroom", async () => {
    const { TOP_HOLDERS_LIMIT_MAX } = await import("../src/route-limits.ts");
    assert.ok(
      TOP_HOLDERS_PROJECTION_ROW_LIMIT >= TOP_HOLDERS_LIMIT_MAX * 10,
      "the artifact must carry many pages more than one request can ask for",
    );
  });
});
