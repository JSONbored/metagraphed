// The account summary card, served from the lakehouse (#9254).
//
// /api/v1/accounts/{ss58} answered an all-zero card while the SAME account's
// own detail routes read real rows from the same table: /events returned 6
// events and /registrations 146 for the address whose summary said
// `event_count: 0`. The handler had a single Postgres read, so one tier miss
// zeroed every field on the card at once.
//
// The two properties worth pinning are the ones a plausible implementation gets
// wrong: the card must attribute events the same way the feed does, and the
// capped-scan boundary must survive the probe that used to answer it being
// folded into the aggregate (it was the query that aborted -- see "two reads").
import assert from "node:assert/strict";
import { resetAccountSummaryPointerCache } from "../src/account-summary-projection.ts";
import { visibleInWindow } from "./helpers/scan-window.ts";
import {
  ACCOUNT_SUMMARY_POINTER_KEY,
  accountSummaryShardKey,
} from "../src/account-summary-projection.ts";
import { readFileSync } from "node:fs";
import { describe, test, beforeEach, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { accountSummaryArchive } from "./helpers/cold-tier-env.ts";

// The card's post-fold probe reads `chain_detail_account_events` through
// src/read-store.ts, which builds `new Client(...)` itself -- so the module is
// the seam. See tests/helpers/pg-mock.ts for why the controller is hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import {
  foldSummaryGroups,
  loadAccountSummaryColdTier,
  mergeNewestEvents,
  type FeedKeyed,
} from "../src/account-feeds-cold-tier.ts";
import {
  ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
  ACCOUNT_SUMMARY_RECENT_LIMIT,
  buildAccountSummary,
} from "../src/account-events.ts";

type Row = Record<string, unknown>;

// The pointer memo is module-level and reset only between test FILES, so
// whichever test resolved it first would decide every later test's generation.
// Same reasoning as `resetDecodeWatermarkCache` in
// tests/analytics-edge-cache.test.ts.
beforeEach(() => resetAccountSummaryPointerCache());

const SS58 = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

const AGG = {
  c: 6,
  fb: 8_700_000,
  lb: 8_760_000,
  fo: 1_784_000_000_000,
  lo: 1_785_000_000_000,
};
/**
 * The ONE grouped read that replaced three (#9386).
 *
 * `GROUP BY event_kind, netuid` over the same `scan` CTE the three separate reads
 * aggregated. These rows must fold back to AGG exactly: 4 + 2 = 6 events, min/max
 * block and observed spanning both groups, and two distinct netuids.
 */
const GROUPS = [
  {
    kind: "AxonServed",
    netuid: 55,
    count: 4,
    fb: 8_700_000,
    lb: 8_750_000,
    fo: 1_784_000_000_000,
    lo: 1_784_900_000_000,
  },
  {
    kind: "NeuronRegistered",
    netuid: 7,
    count: 2,
    fb: 8_710_000,
    lb: 8_760_000,
    fo: 1_784_100_000_000,
    lo: 1_785_000_000_000,
  },
];
const RECENT = [
  {
    block_number: 8_760_000,
    event_kind: "AxonServed",
    netuid: 55,
    observed_at: AGG.lo,
  },
];

/**
 * Answers each of the TWO reads by the shape of its SQL.
 *
 * Two, not five: the aggregate, the distinct-subnet count and the per-kind counts all
 * grouped the same CTE, so one `GROUP BY event_kind, netuid` yields all of them
 * (#9386) -- and the cap probe that stayed behind is gone too, because the CTE now
 * reads CAP + 1 and its own row count IS the probe's number. Only the recent feed
 * cannot fold in: it selects whole rows in a different order.
 */
function fakeEngine(
  overrides: {
    groups?: Row[] | null;
    recent?: Row[] | null;
  } = {},
) {
  const seen: string[] = [];
  const errors: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (
    _env: unknown,
    sql: string,
    deps?: { onError?: (detail: string) => void },
  ) => {
    seen.push(sql);
    const grouped = sql.includes("GROUP BY event_kind, netuid");
    const answer = grouped
      ? pick(overrides.groups, GROUPS)
      : pick(overrides.recent, RECENT);
    if (answer === null) {
      // Mirrors r2SqlQuery: the engine's own explanation is reported, then null.
      deps?.onError?.("r2 sql: HTTP 500 (stubbed failure)");
      errors.push(sql);
      return answer;
    }
    // WINDOW-AWARE (#11131): a group row's newest observation is `lo`, a feed
    // row carries its own `observed_at`. See tests/helpers/scan-window.ts for
    // why a double that replays its fixture per window proves nothing.
    return visibleInWindow(sql, answer as Row[], (row: Row) =>
      grouped ? row.lo : row.observed_at,
    );
  };

  return {
    query,
    seen,
    errors,
    groups: () => seen.find((s) => s.includes("GROUP BY event_kind, netuid"))!,
  };
}

/** Grouped rows whose counts sum to `total`, for driving the cap boundary
 * through the aggregate now that no separate probe reports it. */
function groupsSummingTo(total: number): Row[] {
  return [
    {
      kind: "AxonServed",
      netuid: 55,
      count: total,
      fb: AGG.fb,
      lb: AGG.lb,
      fo: AGG.fo,
      lo: AGG.lo,
    },
  ];
}

describe("loadAccountSummaryColdTier", () => {
  test("returns the four halves the summary builder composes", async () => {
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.equal(cold.declined, undefined);
    const card = buildAccountSummary(SS58, cold as never);
    assert.equal(card.event_count, 6);
    assert.equal(card.subnet_count, 2);
    assert.equal(card.event_kinds.length, 2);
    assert.equal(card.recent_events.length, 1);
    assert.equal(card.event_scan_capped, false);
  });

  test("no read anywhere uses COUNT(DISTINCT)", async () => {
    // R2 SQL REJECTS an ungrouped count(DISTINCT) at this scale --
    //
    //   40015: scan budget exceeded: scanning too much data for
    //   count(DISTINCT) without GROUP BY
    //
    // -- and a rejected read declines the whole reader, so this card published
    // event_count 0 for an address whose own /events feed returned rows.
    const engine = fakeEngine();
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    for (const sql of engine.seen) {
      assert.doesNotMatch(
        sql,
        /count\(\s*DISTINCT/i,
        `R2 SQL rejects this at production scale: ${sql.slice(0, 120)}`,
      );
    }
  });

  test("the distinct-subnet count still GROUPS -- it is not a count(DISTINCT)", async () => {
    // The `scan` CTE caps at ACCOUNT_EVENT_SUMMARY_SCAN_CAP rows, which makes a
    // count(DISTINCT) over it LOOK obviously safe -- an aggregate over 5,000 rows. It
    // is not: the engine costs the distinct against the underlying scan, not the
    // materialized cap. Folding the count out of a GROUP BY keeps that property while
    // removing a whole read.
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.match(engine.groups(), /GROUP BY event_kind, netuid/);
    assert.equal(buildAccountSummary(SS58, cold as never).subnet_count, 2);
  });

  test("TWO READS AND NEITHER IS A FULL SCAN, for a busy account", async () => {
    // The shape of the #9386 failure: five concurrent broad scans of an
    // unpartitioned table under Promise.all, so the success probability was the
    // PRODUCT of five. A single count(*) on account_events reports ~3,390 R2
    // requests, so each removed scan is real cost as well as real risk.
    //
    // The third read went the same way for a measured reason: 32 of the 34
    // request-path r2-sql timeouts on 2026-08-10 were the cap probe, and it
    // declined this route on 92% of calls.
    //
    // #11131 keeps the count at two AND takes the full scan out of both. The
    // account #9386 measured declining ~50% of the time was a HIGH-ACTIVITY
    // coldkey, which is exactly this case: its events fill the first window, so
    // each leg answers from a bounded read that measured 0.1 MB against 577.5.
    // Dated NOW, because that is what "busy" means here: the events are inside
    // the first two-day probe, so neither leg ever reaches for the full read.
    const fresh = Date.now();
    const engine = fakeEngine({
      groups: [
        {
          ...groupsSummingTo(ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1)[0]!,
          lo: fresh,
        },
      ],
      recent: Array.from({ length: ACCOUNT_SUMMARY_RECENT_LIMIT }, (_, i) => ({
        block_number: AGG.lb - i,
        event_kind: "AxonServed",
        netuid: 55,
        observed_at: fresh - i,
      })),
    });
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.equal(engine.seen.length, 2, engine.seen.join("\n").slice(0, 400));
    for (const sql of engine.seen) {
      assert.match(
        sql,
        /observed_at >= \d+/,
        `a busy account must never reach the unbounded read: ${sql.slice(0, 140)}`,
      );
    }
  });

  test("a QUIET account cannot cost more than one extra query per leg", async () => {
    // The other direction, and the one a bound can make worse rather than
    // better. Proving an account has fewer than CAP events means reading its
    // whole history -- the widest window is `block_number >= 0`, which prunes
    // nothing -- so widening repeatedly would charge extra queries for the same
    // full scan it was trying to avoid.
    //
    // So the aggregate leg is deliberately two-phase (one window, then the
    // unbounded read) rather than a walk, and the ceiling below is what stops a
    // future "just widen once more" from quietly reintroducing #9386's product
    // of five. The feed leg does walk, because its slices are disjoint: it pays
    // the same bytes as one scan, split into queries that each finish under the
    // 15s r2-sql ceiling the single one aborted on.
    const engine = fakeEngine();
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    // ONE floorless read per leg and no more. That read is the whole remainder,
    // which is exactly the query this route always issued -- so a quiet account
    // pays the probes on top of it and nothing else. Widening instead would buy
    // the same scan several times over (8 queries / 3,834 MB, measured).
    const floorless = engine.seen.filter((s) => !/observed_at >= \d+/.test(s));
    assert.equal(
      floorless.length,
      2,
      `one per leg, no more:\n${floorless.join("\n").slice(0, 400)}`,
    );
    assert.ok(
      engine.seen.length <= 6,
      `${engine.seen.length} reads for one quiet account:\n${engine.seen.join("\n").slice(0, 400)}`,
    );
  });

  test("no read scans without an ORDER BY to stop early on", async () => {
    // Why the probe was the leg that aborted: `LIMIT n` with no ORDER BY gives
    // the engine no sorted prefix to stop on, so proving there is no n'th row
    // means scanning the whole unpartitioned table -- slowest for the accounts
    // with the FEWEST events, which is backwards from what it protected.
    const engine = fakeEngine();
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    for (const sql of engine.seen) {
      assert.ok(
        /ORDER BY/.test(sql),
        `every read must give the engine a sorted prefix: ${sql.slice(0, 160)}`,
      );
    }
  });

  test("the fold reproduces the three reads it replaced, exactly", async () => {
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    const card = buildAccountSummary(SS58, cold as never);
    assert.equal(card.event_count, 6, "count(*) == group counts summed");
    assert.equal(
      card.subnet_count,
      2,
      "GROUP BY netuid == distinct netuid keys",
    );
    assert.deepEqual(
      (card.event_kinds as Array<{ kind: string; count: number }>).map((k) => [
        k.kind,
        k.count,
      ]),
      [
        ["AxonServed", 4],
        ["NeuronRegistered", 2],
      ],
    );
    assert.equal(card.first_block, 8_700_000, "min ACROSS groups");
    assert.equal(card.last_block, 8_760_000);
  });

  test("one kind spread over several subnets folds back to one kind row", async () => {
    // The grouping is finer than the shape it reproduces, so a kind appearing on N
    // subnets must be summed, not published N times.
    const engine = fakeEngine({
      groups: [
        {
          kind: "AxonServed",
          netuid: 1,
          count: 3,
          fb: 10,
          lb: 20,
          fo: 1,
          lo: 2,
        },
        {
          kind: "AxonServed",
          netuid: 2,
          count: 5,
          fb: 5,
          lb: 30,
          fo: 0,
          lo: 9,
        },
      ],
    });
    const card = buildAccountSummary(
      SS58,
      (await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      })) as never,
    );
    assert.deepEqual(card.event_kinds, [{ kind: "AxonServed", count: 8 }]);
    assert.equal(card.event_count, 8);
    assert.equal(card.subnet_count, 2);
    assert.equal(
      card.first_block,
      5,
      "min across groups, not the first group's",
    );
    assert.equal(card.last_block, 30);
  });

  test("a NULL netuid is its own distinct group, as SQL counted it", async () => {
    // `count(*) FROM (SELECT netuid FROM scan GROUP BY netuid)` treats NULL as a
    // group. Filtering nulls out of the fold would quietly shrink subnet_count by one.
    const engine = fakeEngine({
      groups: [
        {
          kind: "Transfer",
          netuid: null,
          count: 2,
          fb: 1,
          lb: 2,
          fo: 1,
          lo: 2,
        },
        { kind: "Transfer", netuid: 9, count: 1, fb: 3, lb: 4, fo: 3, lo: 4 },
      ],
    });
    const card = buildAccountSummary(
      SS58,
      (await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      })) as never,
    );
    assert.equal(card.subnet_count, 2, "NULL counts as a distinct netuid");
  });

  test("a later group with a smaller max does not lower the running max", async () => {
    // min/max fold across groups in arrival order, so a group whose own max is below
    // the running one must be ignored rather than overwrite it.
    const engine = fakeEngine({
      groups: [
        { kind: "A", netuid: 1, count: 1, fb: 50, lb: 900, fo: 50, lo: 900 },
        { kind: "B", netuid: 2, count: 1, fb: 10, lb: 100, fo: 10, lo: 100 },
      ],
    });
    const card = buildAccountSummary(
      SS58,
      (await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      })) as never,
    );
    assert.equal(
      card.last_block,
      900,
      "the larger max survives the smaller one",
    );
    assert.equal(
      card.first_block,
      10,
      "and the smaller min survives the larger",
    );
  });

  test("an unreadable count contributes nothing rather than NaN", async () => {
    // A count cell that is not a number must not poison event_count -- a NaN there
    // would serialize as null and read as "no events" for an account that has them.
    const engine = fakeEngine({
      groups: [
        {
          kind: "A",
          netuid: 1,
          count: "not-a-number",
          fb: 1,
          lb: 2,
          fo: 1,
          lo: 2,
        },
        { kind: "B", netuid: 2, count: 3, fb: 1, lb: 2, fo: 1, lo: 2 },
      ],
    });
    const card = buildAccountSummary(
      SS58,
      (await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      })) as never,
    );
    assert.equal(card.event_count, 3);
    assert.equal(Number.isNaN(card.event_count as number), false);
  });

  test("a NULL event_kind stays its own group in the fold, as SQL grouped it", () => {
    // `GROUP BY event_kind` treats NULL as a group, so the fold must too -- collapsing
    // it into a neighbouring kind would move those events onto the wrong label.
    // buildAccountSummary then drops the unnamed group from the PUBLISHED list (it
    // filters `k.kind`), which is right: an event kind with no name cannot be named.
    // Asserted at the fold rather than through the card so the two behaviours stay
    // distinguishable — the fold's job is equivalence, the builder's is presentation.
    const folded = foldSummaryGroups([
      { kind: null, netuid: 1, count: 2, fb: 1, lb: 2, fo: 1, lo: 2 },
      { kind: "A", netuid: 1, count: 1, fb: 1, lb: 2, fo: 1, lo: 2 },
    ]);
    assert.equal(folded.kinds.length, 2, "the NULL group survives the fold");
    assert.deepEqual(
      folded.kinds.find((k) => k.kind === null),
      { kind: null, count: 2 },
    );
    assert.equal(
      folded.agg.c,
      3,
      "and its events still count toward the total",
    );
  });

  test("an all-NULL column stays NULL rather than folding to zero", async () => {
    // SQL min/max skip NULLs, so a column that is entirely NULL yields NULL. A fold
    // seeded from 0 would publish block 0 as this account's first-ever event.
    const engine = fakeEngine({
      groups: [
        {
          kind: "Transfer",
          netuid: 1,
          count: 2,
          fb: null,
          lb: null,
          fo: null,
          lo: null,
        },
      ],
    });
    const card = buildAccountSummary(
      SS58,
      (await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      })) as never,
    );
    assert.equal(card.first_block, null);
    assert.equal(card.last_block, null);
    assert.equal(card.event_count, 2, "the count is still exact");
  });

  test("attributes events by hotkey OR coldkey, like the feed", async () => {
    // The card and /accounts/{ss58}/events describe the SAME event set. An
    // attribution that differed between them would reintroduce the very
    // disagreement this fixes, only harder to see.
    const engine = fakeEngine();
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    for (const sql of engine.seen) {
      assert.match(
        sql,
        new RegExp(`\\(hotkey = '${SS58}' OR coldkey = '${SS58}'\\)`),
        `every read must use the feed's attribution: ${sql.slice(0, 90)}`,
      );
    }
  });

  test("the CTE looks one row past the cap, and nothing else is read", async () => {
    // The extra row is what retired the separate probe: the CTE's own row count
    // is min(total, CAP + 1), which is byte-for-byte what the probe returned.
    const engine = fakeEngine();
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.match(
      engine.groups(),
      new RegExp(`LIMIT ${ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1}`),
      "the aggregate must look one row past the cap",
    );
    assert.equal(
      engine.seen.filter((s) => s.includes("count(*) AS c FROM (")).length,
      0,
      "the standalone cap probe must be gone",
    );
  });

  // The property #9386 added the probe to protect, now carried by the aggregate.
  // Reusing a CAP-wide count would make an account with EXACTLY CAP events look
  // capped, nulling first_block/first_seen_at on a card whose totals are exact.
  test("exactly CAP events is complete; CAP + 1 is capped", async () => {
    for (const [total, capped] of [
      [ACCOUNT_EVENT_SUMMARY_SCAN_CAP, false],
      [ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1, true],
    ] as const) {
      const engine = fakeEngine({ groups: groupsSummingTo(total) });
      const cold = await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      });
      const card = buildAccountSummary(SS58, cold as never);
      assert.equal(card.event_scan_capped, capped, `total=${total}`);
      // A capped window's minimum is a floor, not the account's first-ever.
      assert.equal(card.first_block === null, capped);
      assert.equal(card.first_seen_at === null, capped);
      // The newest end stays exact either way.
      assert.equal(card.last_block, AGG.lb);
      // The PUBLISHED window is still the cap: reading CAP + 1 rows answers the
      // capped question without widening what the card reports.
      assert.equal(
        card.event_count,
        Math.min(total, ACCOUNT_EVENT_SUMMARY_SCAN_CAP),
      );
    }
  });

  test("declines when any leg misses", async () => {
    // A card mixing measured aggregates with a zeroed count would silently flip
    // event_scan_capped and publish a window floor as first_seen_at.
    for (const miss of [{ groups: null }, { recent: null }]) {
      const engine = fakeEngine(miss);
      const cold = await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      });
      assert.ok(cold.declined, `${JSON.stringify(miss)} must decline`);
    }
  });

  test("an empty grouped read is a real answer, not a decline", async () => {
    // An account with no events in the window genuinely has none. Declining here
    // would turn "nothing happened" into "we could not look", which is the opposite
    // of the confident-zero this route's decline exists to prevent.
    const engine = fakeEngine({ groups: [], recent: [] });
    const cold = await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.equal(cold.declined, undefined);
    const card = buildAccountSummary(SS58, cold as never);
    assert.equal(card.event_count, 0);
    assert.equal(card.subnet_count, 0);
  });

  test("a decline says WHICH leg failed and what the engine said", async () => {
    // #9386: this route declined ~50% of requests for a high-activity coldkey with a
    // typed 503 that named no cause, so the mechanism -- timeout, scan budget, HTTP
    // error -- could only be guessed at from outside.
    const engine = fakeEngine({ groups: null });
    const cold = await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.ok(cold.declined);
    assert.equal(cold.declined.length, 1);
    assert.match(cold.declined[0], /^summary-groups: /);
    assert.match(cold.declined[0], /HTTP 500/, "the engine's own explanation");
  });

  test("every failed leg is named, not just the first", async () => {
    const engine = fakeEngine({ groups: null, recent: null });
    const cold = await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.ok(cold.declined);
    assert.deepEqual(cold.declined.map((r) => r.split(":")[0]).sort(), [
      "recent-feed",
      "summary-groups",
    ]);
  });

  test("an unusable address declines rather than scanning every account", async () => {
    for (const bad of ["", "not-an-address", "'; DROP TABLE x --"]) {
      const engine = fakeEngine();
      const cold = await loadAccountSummaryColdTier({} as never, bad, {
        query: engine.query as never,
      });
      assert.ok(cold.declined, `${bad} must decline`);
      assert.equal(engine.seen.length, 0, "must not reach the engine at all");
    }
  });

  test("an unusable recent limit declines", async () => {
    for (const recentLimit of [0, -1, 1.5]) {
      const engine = fakeEngine();
      const cold = await loadAccountSummaryColdTier({} as never, SS58, {
        recentLimit,
        query: engine.query as never,
      });
      assert.ok(cold.declined, `recentLimit ${recentLimit}`);
    }
  });
});

describe("all three account-summary surfaces go through the one composer", () => {
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  // #9263 tightened this from "every surface calls the loader" to "every
  // surface calls the SAME composer". Three call sites each assembling the
  // card themselves is how one of them ends up a version behind: #9257 wired
  // the event half into all three, and all three still shipped an empty
  // `registrations` because that leg was assembled separately.
  test("every surface calls answerAccountSummary, not its own assembly", () => {
    for (const [surface, path] of Object.entries(sources)) {
      const source = readFileSync(path, "utf8");
      assert.match(
        source,
        /answerAccountSummary\(/,
        `${surface} (${path}) would keep answering the all-zero card`,
      );
      assert.doesNotMatch(
        source,
        /loadAccountSummaryColdTier\(/,
        `${surface} (${path}) must not compose the card itself`,
      );
    }
  });

  test("and the composer is the only thing that calls the loader", () => {
    assert.match(
      readFileSync("src/account-summary-card.ts", "utf8"),
      /loadAccountSummaryColdTier\(/,
    );
  });
});

describe("the projection short-circuits the aggregate leg (#11131)", () => {
  const GEN = "20260814T100000Z";
  const SHARDS = 16384;
  const SHARD_KEY = accountSummaryShardKey(SS58, SHARDS, GEN);

  /** An archive binding holding one shard for this account. */
  function archive(groups: unknown[] | null) {
    const stamp = new Date().toISOString();
    return {
      METAGRAPH_ARCHIVE: {
        get: async (key: string) => {
          if (!groups) return null;
          if (key === ACCOUNT_SUMMARY_POINTER_KEY) {
            return {
              json: async () => ({
                schema_version: 1,
                generation: GEN,
                shard_count: SHARDS,
                generated_at: stamp,
                account_count: 1,
              }),
            };
          }
          if (key === SHARD_KEY) {
            return {
              json: async () => ({
                schema_version: 1,
                accounts: { [SS58]: groups },
              }),
            };
          }
          return null;
        },
      },
    } as never;
  }

  test("THE 4,374 MB SCAN IS NOT ISSUED when the shard answers", async () => {
    // The measured cost this whole change exists to remove. The grouped leg is
    // a lifetime aggregate over a scattered key, so no window bounds it -- the
    // only fix is to not run it per request.
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier(
      archive([
        {
          kind: "AxonServed",
          netuid: 55,
          count: 4,
          fb: 8_700_000,
          lb: 8_750_000,
          fo: AGG.fo,
          lo: AGG.lo,
        },
        {
          kind: "NeuronRegistered",
          netuid: 7,
          count: 2,
          fb: 8_710_000,
          lb: 8_760_000,
          fo: AGG.fo,
          lo: AGG.lo,
        },
      ]),
      SS58,
      { query: engine.query as never },
    );

    assert.equal(cold.declined, undefined);
    for (const sql of engine.seen) {
      assert.doesNotMatch(
        sql,
        /GROUP BY event_kind, netuid/,
        `the grouped scan must not run: ${sql.slice(0, 120)}`,
      );
    }
    // The card is still built from the SAME builder over the SAME shape.
    const card = buildAccountSummary(SS58, cold as never);
    assert.equal(card.event_count, 6);
    assert.equal(card.subnet_count, 2);
    assert.equal(card.event_kinds.length, 2);
  });

  test("a shard that cannot answer falls back to the scan, unchanged", async () => {
    // The safety property: shipping the reader before the producer has
    // backfilled must be indistinguishable from not shipping it.
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier(archive(null), SS58, {
      query: engine.query as never,
    });
    assert.equal(cold.declined, undefined);
    assert.ok(
      engine.seen.some((s) => s.includes("GROUP BY event_kind, netuid")),
      "the lakehouse leg must still run",
    );
    assert.equal(buildAccountSummary(SS58, cold as never).event_count, 6);
  });

  test("AN OVER-CAP ACCOUNT FALLS BACK -- the tiers must not disagree", async () => {
    // I shipped this wrong and production caught it. The projection aggregates
    // an account's WHOLE history; this leg aggregates the newest CAP events.
    // `event_count` clamps to CAP either way, so the divergence hides there --
    // but `event_kinds` and `subnet_count` widen to lifetime. Measured live:
    // 4 kinds / 2 subnets from the lakehouse against 10 / 3 from the shard.
    //
    // So above the cap the projection declines and this leg runs, which is what
    // keeps one route from having two answers.
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier(
      archive([
        {
          kind: "AxonServed",
          netuid: 55,
          count: ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 500,
          fb: 1,
          lb: 2,
          fo: AGG.fo,
          lo: AGG.lo,
        },
      ]),
      SS58,
      { query: engine.query as never },
    );
    assert.ok(
      engine.seen.some((s) => s.includes("GROUP BY event_kind, netuid")),
      "the lakehouse leg must answer for an account the shard cannot",
    );
    const card = buildAccountSummary(SS58, cold as never);
    assert.equal(card.event_count, 6);
    assert.equal(card.event_scan_capped, false);
  });
});

describe("the projection short-circuits the FEED leg too (#11222)", () => {
  const GEN = "20260814T100000Z";
  const SHARDS = 16384;
  const SHARD_KEY = accountSummaryShardKey(SS58, SHARDS, GEN);
  const THROUGH = "2026-08-13";
  const FLOOR = Date.parse("2026-08-14T00:00:00.000Z");

  /** One published event, in the lakehouse table's column names. */
  function event(over: Row = {}): Row {
    return {
      block_number: 8_700_000,
      event_index: 0,
      extrinsic_index: null,
      event_kind: "AxonServed",
      hotkey: SS58,
      coldkey: null,
      netuid: 55,
      uid: 1,
      amount_tao: null,
      alpha_amount: null,
      observed_at: Date.parse("2026-08-13T09:00:00Z"),
      ...over,
    };
  }

  /** An archive holding this account's groups AND its published newest events. */
  function archive(recent: Row[] | null, { limit = 10 } = {}) {
    const stamp = new Date().toISOString();
    return {
      METAGRAPH_ARCHIVE: {
        get: async (key: string) => {
          if (key === ACCOUNT_SUMMARY_POINTER_KEY) {
            return {
              json: async () => ({
                schema_version: 1,
                generation: GEN,
                shard_count: SHARDS,
                generated_at: stamp,
                account_count: 1,
                through: THROUGH,
                ...(recent ? { recent_limit: limit } : {}),
              }),
            };
          }
          if (key === SHARD_KEY) {
            return {
              json: async () => ({
                schema_version: 1,
                // The groups sum to the LIST'S LENGTH, so the fixture is a
                // complete list by construction. The reader serves a list only
                // when it holds `min(recent_limit, lifetime)` entries, and a
                // fixture claiming six lifetime events beside one published
                // one would fall back for a reason none of these tests is
                // about -- see the completeness suite in
                // account-summary-projection.test.ts.
                accounts: {
                  [SS58]: groupsSummingTo((recent ?? []).length || 1),
                },
                ...(recent ? { recent: { [SS58]: recent } } : {}),
              }),
            };
          }
          return null;
        },
      },
    } as never;
  }

  test("THE UNBOUNDED SCAN IS REPLACED BY ONE FLOORED PROBE", async () => {
    // The read that times this route out. `windowedRowRead`'s last step has no
    // floor at all, and 95.8% of accounts reach it -- measured on production
    // 2026-08-15, three of nine real accounts 503'd at the 15s ceiling and the
    // rest took 10-19s.
    const engine = fakeEngine({ recent: [] });
    const cold = await loadAccountSummaryColdTier(archive([event()]), SS58, {
      query: engine.query as never,
    });
    assert.equal(cold.declined, undefined);
    const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
    assert.equal(feed.length, 1, "one probe, not a walk");
    assert.match(feed[0]!, new RegExp(`observed_at >= ${FLOOR}\\b`));
    // And no read may be issued without that floor -- an unfloored SELECT here
    // is the whole defect coming back.
    for (const sql of feed) {
      assert.match(
        sql,
        /observed_at >= /,
        `unfloored read: ${sql.slice(0, 90)}`,
      );
    }
  });

  test("the card's COUNT includes what the fold was too early to see", async () => {
    // Measured 2026-08-16 on 5EEmaGFE...5oM3qDSC: the projection's groups held
    // ONE NeuronRegistered at block 8836052, the feed's newest row was block
    // 8850439, and the card published `event_count: 1` beside a two-row feed.
    // The aggregate leg served the projection verbatim, so it reported the count
    // as of the fold while the feed reported it as of now. Whichever is right,
    // they cannot both be.
    const postFold = {
      kind: "NeuronRegistered",
      netuid: 105,
      count: 1,
      fb: 8_850_439,
      lb: 8_850_439,
      fo: FLOOR + 3_600_000,
      lo: FLOOR + 3_600_000,
    };
    const seen: string[] = [];
    // The GROUPED read is the one under test, so it answers only the post-fold
    // window -- the folded half comes from the projection, not from here.
    const engine = async (
      _env: unknown,
      sql: string,
      _deps?: { onError?: (d: string) => void },
    ) => {
      seen.push(sql);
      if (sql.includes("GROUP BY event_kind, netuid")) return [postFold];
      return [];
    };
    const cold = await loadAccountSummaryColdTier(archive(null), SS58, {
      query: engine as never,
    });
    assert.equal(cold.declined, undefined);
    // The projection's groupsSummingTo(1) plus the one event above the fold.
    assert.equal(
      cold.agg?.c,
      2,
      "the count must span the fold, not stop at it",
    );
    // ...and the probe that found it is BOUNDED to the post-fold window, so the
    // accuracy does not cost the lifetime scan back.
    const grouped = seen.filter((q) =>
      q.includes("GROUP BY event_kind, netuid"),
    );
    assert.equal(grouped.length, 1);
    assert.match(grouped[0]!, new RegExp(`observed_at >= ${FLOOR}\\b`));
  });

  test("a failed post-fold probe DECLINES rather than publishing the stale count", async () => {
    // Falling back to the groups alone would republish the self-contradicting
    // card this exists to fix, and would do it silently.
    const engine = async (
      _env: unknown,
      sql: string,
      deps?: { onError?: (d: string) => void },
    ) => {
      if (sql.includes("GROUP BY event_kind, netuid")) {
        deps?.onError?.("r2 sql: HTTP 500 (stubbed failure)");
        return null;
      }
      return [];
    };
    const cold = await loadAccountSummaryColdTier(archive(null), SS58, {
      query: engine as never,
    });
    assert.ok(
      cold.declined?.some((r) => r.startsWith("summary-groups-postfold:")),
      `expected a postfold decline, got ${JSON.stringify(cold.declined)}`,
    );
  });

  /**
   * GROUPS BUT NO RECENT MAP -- which is every account in production today.
   *
   * The probe above needs metagraphed-infra#575's published event map. Measured
   * 2026-08-16, no generation carries one: the live pointer publishes no
   * `recent_limit`, and shard 12350 of generation 20260815T062657Z held 43
   * accounts, all groups-only. So `readRecent` declined for EVERY account and
   * the feed fell through to the unbounded lifetime scan -- which is the 15s
   * abort behind the 503 the account page was serving.
   *
   * The groups alone bound it: they are a LIFETIME aggregate, so every folded
   * event sits inside [fo, lo], and `through` says where the fold stops.
   */
  describe("an account with groups but no published recent map", () => {
    test("bounds BOTH reads instead of scanning all of history", async () => {
      const engine = fakeEngine({ recent: [] });
      // `archive(null)` publishes no recent_limit and no recent map -- the
      // production shape, verbatim.
      const cold = await loadAccountSummaryColdTier(archive(null), SS58, {
        query: engine.query as never,
      });
      assert.equal(cold.declined, undefined);
      const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
      assert.equal(feed.length, 2, "above the fold, then the folded remainder");
      // The live half starts exactly where the fold stops.
      assert.match(feed[0]!, new RegExp(`observed_at >= ${FLOOR}\\b`));
      // The folded half is bounded on BOTH sides by the groups' own columns.
      assert.match(feed[1]!, new RegExp(`observed_at >= ${AGG.fo}\\b`));
      assert.match(feed[1]!, new RegExp(`observed_at <= ${AGG.lo}\\b`));
      // The defect coming back would be a read with no lower bound at all.
      for (const sql of feed) {
        assert.match(
          sql,
          /observed_at >= /,
          `unbounded read: ${sql.slice(0, 90)}`,
        );
      }
    });

    test("either bounded read FAILING declines -- never a half feed", async () => {
      // Both halves are load-bearing: serving the live half alone would publish
      // a feed silently missing everything the fold covers, and serving the
      // folded half alone would freeze it at the last complete day. A null from
      // the engine is a decline, exactly as the unbounded walk's was.
      const first = fakeEngine({ recent: null });
      const coldFirst = await loadAccountSummaryColdTier(archive(null), SS58, {
        query: first.query as never,
      });
      assert.ok(
        coldFirst.declined?.some((r) => r.startsWith("recent-span:")),
        "the first probe's failure must be reported as a decline",
      );

      // The SECOND read failing is the harder case: the first one succeeded, so
      // there are rows in hand that a careless implementation would serve.
      let call = 0;
      const flaky = async (
        env: unknown,
        sql: string,
        deps?: { onError?: (detail: string) => void },
      ) => {
        if (sql.includes("GROUP BY")) return good.query(env, sql, deps);
        call += 1;
        if (call === 1) return good.query(env, sql, deps);
        deps?.onError?.("r2 sql: HTTP 500 (stubbed failure)");
        return null;
      };
      const good = fakeEngine({ recent: [event()] });
      const coldSecond = await loadAccountSummaryColdTier(archive(null), SS58, {
        query: flaky as never,
      });
      assert.ok(
        coldSecond.declined?.some((r) => r.startsWith("recent-span:")),
        "a failed folded read must not serve the live half alone",
      );
    });

    test("a full page above the fold needs no second read", async () => {
      // Those rows ARE the newest, so the folded half cannot contribute one.
      const engine = fakeEngine({
        // ABOVE the fold floor, or the first probe's own predicate filters
        // them out and there is nothing to short-circuit on.
        recent: Array.from({ length: ACCOUNT_SUMMARY_RECENT_LIMIT }, (_, i) =>
          event({
            block_number: 8_800_000 + i,
            event_index: i,
            observed_at: FLOOR + 60_000 + i,
          }),
        ),
      });
      await loadAccountSummaryColdTier(archive(null), SS58, {
        query: engine.query as never,
      });
      const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
      assert.equal(feed.length, 1, "the second query must not be issued");
    });
  });

  /**
   * The account the projection has NEVER seen -- every account registered since
   * the last generation, and the case that used to be the slowest thing here.
   *
   * The producer writes every shard, so absence from a shard that exists proves
   * there is nothing at or before `through`. BOTH legs must therefore bound to
   * the floor: bounding only the aggregate half would fix the cheap read and
   * leave the feed scanning the whole table, which is the read that 503s.
   *
   * Measured on production 2026-08-16: an account registered 2026-08-15T13:53,
   * one day past the generation, held exactly ONE event and the route answered
   * `503 account_summary_unavailable` after aborting at the 15s ceiling.
   */
  describe("an account the projection has never seen", () => {
    /** The shard exists and simply does not list this account. */
    const unseen = () => archive(null, { limit: 10 });
    const withoutAccount = () => {
      const base = unseen() as unknown as {
        METAGRAPH_ARCHIVE: { get: (k: string) => Promise<unknown> };
      };
      return {
        METAGRAPH_ARCHIVE: {
          get: async (key: string) => {
            const got = await base.METAGRAPH_ARCHIVE.get(key);
            if (key !== SHARD_KEY || !got) return got;
            // Present, complete, and holding somebody else.
            return { json: async () => ({ schema_version: 1, accounts: {} }) };
          },
        },
      } as never;
    };

    test("EVERY read is floored, not just the aggregate one", async () => {
      const engine = fakeEngine({ recent: [] });
      const cold = await loadAccountSummaryColdTier(withoutAccount(), SS58, {
        query: engine.query as never,
      });
      assert.equal(cold.declined, undefined);
      assert.ok(engine.seen.length > 0, "it still reads the bounded window");
      for (const sql of engine.seen) {
        assert.match(
          sql,
          new RegExp(`observed_at >= ${FLOOR}\\b`),
          `unfloored read for an account proven to have no history: ${sql.slice(0, 120)}`,
        );
      }
    });

    test("the feed leg is ONE probe, never the unbounded walk", async () => {
      // The regression that would undo this: leaving the feed on
      // `windowedRowRead`, whose last step has no floor at all.
      const engine = fakeEngine({ recent: [] });
      await loadAccountSummaryColdTier(withoutAccount(), SS58, {
        query: engine.query as never,
      });
      const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
      assert.equal(feed.length, 1, "one probe, not a walk");
    });

    test("events after the floor are still served, not zeroed", async () => {
      // Absence means "nothing BEFORE the floor" -- emphatically not "no
      // events". A card that published zero here would be confidently wrong
      // about the newly-registered account this whole path exists for.
      const fresh = event({
        block_number: 8_900_000,
        observed_at: Date.parse("2026-08-15T13:53:48Z"),
      });
      const engine = fakeEngine({ recent: [fresh] });
      const cold = await loadAccountSummaryColdTier(withoutAccount(), SS58, {
        query: engine.query as never,
      });
      assert.equal(cold.declined, undefined);
      assert.equal(cold.recent?.length, 1);
      assert.equal(cold.recent?.[0]!.block_number, 8_900_000);
    });
  });

  test("the floor is the END of `through`, not the pointer's clock", async () => {
    // `generated_at` is the run's stamp and sits HOURS after the data it
    // describes -- six, on the generation measured 2026-08-15. Flooring there
    // would drop every event between midnight and the run from the card.
    const engine = fakeEngine({ recent: [] });
    await loadAccountSummaryColdTier(archive([event()]), SS58, {
      query: engine.query as never,
    });
    const probe = engine.seen.find((s) => !s.includes("GROUP BY"))!;
    assert.match(probe, new RegExp(`observed_at >= ${FLOOR}\\b`));
    assert.ok(FLOOR > Date.parse(THROUGH), "the floor is past the day named");
  });

  test("the probe's rows come FIRST, and the published ones fill the page", async () => {
    // The merge is what makes the two halves one feed. A newer event landing
    // after the generation must outrank everything published, or the card
    // freezes at the last day the producer folded.
    const newer = event({
      block_number: 8_900_000,
      event_index: 3,
      observed_at: Date.parse("2026-08-14T06:00:00Z"),
    });
    const engine = fakeEngine({ recent: [newer] });
    const cold = await loadAccountSummaryColdTier(
      archive([event(), event({ block_number: 8_690_000, event_index: 9 })]),
      SS58,
      { query: engine.query as never },
    );
    const recent = (cold as { recent: Row[] }).recent;
    assert.deepEqual(
      recent.map((r) => r.block_number),
      [8_900_000, 8_700_000, 8_690_000],
    );
  });

  test("A FAILED PROBE DECLINES -- it does not serve the published half alone", async () => {
    // Serving what the projection had would publish a feed silently missing
    // the newest events, which are the most visible rows on the card, with
    // nothing in the payload to say so.
    const engine = fakeEngine({ recent: null });
    const cold = await loadAccountSummaryColdTier(archive([event()]), SS58, {
      query: engine.query as never,
    });
    assert.ok(cold.declined, "a failed head probe declines the read");
    assert.ok(
      cold.declined!.some((r) => r.startsWith("recent-head:")),
      `the leg names itself: ${JSON.stringify(cold.declined)}`,
    );
  });

  test("no published recent list still bounds, on the GROUPS instead", async () => {
    // This asserted the unbounded walk until the span bound existed, because
    // without a published list there was nothing for a floor to MEET. The
    // groups supply that edge themselves, so the fallback is now bounded --
    // which matters, since every generation in production lands here.
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier(archive(null), SS58, {
      query: engine.query as never,
    });
    assert.equal(cold.declined, undefined);
    const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
    assert.ok(feed.length >= 1);
    for (const sql of feed) {
      assert.match(
        sql,
        /observed_at >= /,
        `the walk is back: ${sql.slice(0, 90)}`,
      );
    }
  });

  test("a published limit under the caller's need falls back to the span", async () => {
    // The recent map is still refused -- serving a list shorter than the caller
    // asked for would publish a feed missing its tail -- but the fallback is
    // the bounded span read rather than the walk.
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier(
      archive([event()], { limit: ACCOUNT_SUMMARY_RECENT_LIMIT - 1 }),
      SS58,
      { query: engine.query as never },
    );
    assert.equal(cold.declined, undefined);
    const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
    assert.ok(feed.length >= 1);
    for (const sql of feed) {
      assert.match(sql, /observed_at >= /);
    }
  });
});

describe("mergeNewestEvents", () => {
  const row = (observed_at: number, block_number: number, event_index = 0) => ({
    observed_at,
    block_number,
    event_index,
  });

  test("orders on all THREE feed columns, in FEED_ORDER's precedence", () => {
    // Sorting on observed_at alone would reorder events inside a block, and
    // the cursor token the Postgres tier issues encodes the whole triple.
    const merged = mergeNewestEvents(
      [row(100, 5, 0), row(100, 5, 1), row(100, 6, 0), row(99, 9, 9)],
      [],
      10,
    );
    assert.deepEqual(
      merged.map((r) => [r.observed_at, r.block_number, r.event_index]),
      [
        [100, 6, 0],
        [100, 5, 1],
        [100, 5, 0],
        [99, 9, 9],
      ],
    );
  });

  test("de-duplicates on the pair that IDENTIFIES an event", () => {
    // Disjointness is the producer's property, asserted across a repository
    // boundary. A producer that widened its window by an hour would put the
    // same event in both halves, and a duplicated row in a card is a visible
    // wrong answer.
    const merged = mergeNewestEvents([row(100, 5, 0)], [row(100, 5, 0)], 10);
    assert.equal(merged.length, 1);
  });

  test("the page is cut to the limit, newest kept", () => {
    const merged = mergeNewestEvents(
      [row(1, 1), row(2, 2), row(3, 3)],
      [row(4, 4)],
      2,
    );
    assert.deepEqual(
      merged.map((r) => r.block_number),
      [4, 3],
    );
  });

  test("a row missing a sort column sorts LAST, and does not crash", () => {
    // REACHABLE, which is why the fallback is here rather than deleted. The
    // published half is parsed and cannot carry a null in these three, but the
    // head probe's half comes untyped out of R2 SQL and every one of those
    // columns is nullable on `chain.account_events`. A missing key must not
    // throw and must not sort ABOVE a real event -- the card's top row is the
    // most visible thing on it.
    // The type argument is explicit because the fixtures below are DELIBERATELY
    // partial -- one row per nullable sort column -- and left to infer, TS
    // narrows `Row` to a union of those exact literal shapes and then refuses
    // the complete row in the published half. `FeedKeyed` is the shape the
    // merge actually needs, which is what these rows are testing against.
    const merged = mergeNewestEvents<FeedKeyed>(
      [{ observed_at: 50, block_number: 1, event_index: 3 }],
      [
        // One row per nullable sort column, each with an identity of its own so
        // the de-duplication does not fold them together first.
        { block_number: 1, event_index: 0 },
        { observed_at: 100, event_index: 2 },
        { observed_at: 100, block_number: 9 },
      ],
      4,
    );
    assert.deepEqual(
      merged.map((r) => [
        r.observed_at ?? null,
        r.block_number ?? null,
        r.event_index ?? null,
      ]),
      [
        [100, 9, null],
        [100, null, 2],
        [50, 1, 3],
        [null, 1, 0],
      ],
    );
  });

  test("either half may be empty", () => {
    assert.deepEqual(mergeNewestEvents([], [], 10), []);
    assert.equal(mergeNewestEvents([row(1, 1)], [], 10).length, 1);
    assert.equal(mergeNewestEvents([], [row(1, 1)], 10).length, 1);
  });
});

/**
 * The card's post-fold probe, from Neon instead of R2 SQL.
 *
 * `Server-Timing` on the live card, 2026-08-16, with the projection and the
 * pointer memo already in place:
 *
 *   r2;dur=87;desc="2 calls"       the projection: pointer + shard
 *   neon;dur=143;desc="2 calls"    the hot tier
 *   r2sql;dur=3210;desc="2 calls"  the post-fold probes
 *
 * R2 SQL was 87% of a 3,695ms request at ~1.6s per query. The probes were not
 * badly bounded -- they asked the wrong store. `chain_detail_account_events`
 * holds exactly that window and answers in milliseconds.
 */
/** The projection the card needs to reach its post-fold legs at all. */
const cardArchive = () =>
  accountSummaryArchive({
    accounts: {
      [SS58]: [
        {
          kind: "NeuronRegistered",
          netuid: 105,
          count: 2,
          fb: 10,
          lb: 90,
          fo: 1_700_000_000_010,
          lo: 1_700_000_000_090,
        },
      ],
    },
    // The PRODUCER's row shape, not the card's output shape:
    // `AccountSummaryRecentEventSchema` is `.required().strict()`, so a
    // payload missing a column is refused and the card silently takes
    // the span branch instead -- which is what the first cut of this
    // fixture did.
    recent: {
      [SS58]: [9_000_000, 8_999_999].map((block) => ({
        block_number: block,
        event_index: 0,
        extrinsic_index: 1,
        event_kind: "NeuronRegistered",
        hotkey: SS58,
        coldkey: null,
        netuid: 105,
        uid: 242,
        amount_tao: null,
        alpha_amount: null,
        observed_at: Date.parse("2026-08-14T12:00:00.000Z"),
      })),
    },
    pointer: { recent_limit: 10, recent_from: "2026-07-16" },
    through: "2026-08-14",
  });

describe("the card's head probe -- Neon when the tiers overlap", () => {
  const FOLD_FLOOR = Date.parse("2026-08-15T00:00:00.000Z");

  /** A store answering the floor probe and the per-account read. */
  function store(floorMs: number | null, rows: Record<string, unknown>[]) {
    pg.control.queries.length = 0;
    pg.control.answers = [];
    pg.control.rows = null;
    pg.control.failNext = null;
    pg.control.onQuery = ({ text }) => {
      pg.control.rows = text.includes("MIN(observed_at)")
        ? floorMs === null
          ? [{ floor_ms: null }]
          : [{ floor_ms: floorMs }]
        : rows;
    };
    return pgMockEnv();
  }

  const hotRow = (block: number) => ({
    block_number: block,
    event_index: 0,
    extrinsic_index: 1,
    event_kind: "NeuronRegistered",
    hotkey: SS58,
    coldkey: null,
    netuid: 105,
    uid: 242,
    amount_tao: "12.5",
    alpha_amount: null,
    observed_at: Date.parse("2026-08-15T12:00:00.000Z"),
  });

  test("THE HEAD PROBE ASKS NEON, not the lakehouse", async () => {
    const queries: string[] = [];
    const probe = await headProbeForTest({
      env: store(FOLD_FLOOR - 90 * 60_000, [hotRow(9_000_001)]),
      queries,
      floorMs: FOLD_FLOOR,
    });
    assert.ok(probe, "the probe answered");
    assert.equal(
      queries.length,
      0,
      `expected no R2 SQL:\n${queries.join("\n")}`,
    );
    assert.equal(probe[0]!.block_number, 9_000_001);
  });

  test("A GAP FALLS BACK to the bounded R2 SQL probe", async () => {
    // Both edges move on their own schedules, so a gap is possible -- and a
    // page built across one is silently missing every event in it.
    const queries: string[] = [];
    await headProbeForTest({
      env: store(FOLD_FLOOR + 60 * 60_000, [hotRow(9_000_001)]),
      queries,
      floorMs: FOLD_FLOOR,
    });
    // BOTH legs fall back, not one: the aggregate and the head probe read the
    // same post-fold window, so a gap disqualifies both.
    assert.ok(queries.length >= 1, "expected the R2 SQL probes");
    assert.ok(
      queries.every((sql) => sql.includes(`observed_at >= ${FOLD_FLOOR}`)),
      queries.join("\n"),
    );
  });

  test("THE FOLD AGGREGATES like the SQL it replaces", async () => {
    // FOUR rows, deliberately unordered and deliberately colliding: two share a
    // (kind, netuid) so the merge path runs, and the second one moves BOTH ends
    // outward so the running min and max are each exercised in both directions.
    // One ordered pair would leave half of every comparison untaken -- the same
    // argument the span test makes about its three groups.
    //
    // A NULL netuid is its own group, not a coalesced one: Transfer and Deposit
    // are coldkey balance events with no subnet, and folding them onto a
    // netuid-bearing kind would invent a subnet for them.
    const at = (iso: string) => Date.parse(iso);
    const row = (
      kind: string,
      netuid: number | null,
      block: number,
      iso: string,
    ) => ({
      block_number: block,
      event_index: 0,
      extrinsic_index: 1,
      event_kind: kind,
      hotkey: SS58,
      coldkey: null,
      netuid,
      uid: 242,
      amount_tao: null,
      alpha_amount: null,
      observed_at: at(iso),
    });
    const queries: string[] = [];
    const card = await postFoldGroupsForTest({
      env: store(FOLD_FLOOR - 90 * 60_000, [
        row("StakeAdded", 7, 500, "2026-08-15T12:00:00.000Z"),
        row("StakeAdded", 7, 100, "2026-08-15T20:00:00.000Z"),
        row("StakeAdded", 9, 300, "2026-08-15T14:00:00.000Z"),
        row("Transfer", null, 400, "2026-08-15T15:00:00.000Z"),
      ]),
      queries,
    });
    assert.equal(
      queries.length,
      0,
      `expected no R2 SQL:\n${queries.join("\n")}`,
    );
    assert.ok("agg" in card, `the card declined: ${JSON.stringify(card)}`);

    // `scanned` is `sum(count)` over the folded groups, which is the number the
    // SQL aggregate returned. Two published events plus the four above -- and
    // it is 6 rather than 3 only if the colliding pair was COUNTED twice while
    // being GROUPED once, which is the whole property.
    assert.equal(card.scanned, 6);

    const byKind = new Map(card.kinds.map((k) => [String(k.kind), k]));
    assert.deepEqual(
      [...byKind.keys()].sort(),
      ["NeuronRegistered", "StakeAdded", "Transfer"],
      "a null-netuid kind is folded on its own, not onto a subnet-bearing one",
    );
    assert.equal(
      Number(byKind.get("StakeAdded")!.count),
      3,
      "two netuid-7 rows plus one netuid-9",
    );
  });

  test("A ROW MISSING ITS SORT COLUMNS folds without corrupting the bounds", async () => {
    // REACHABLE for the reason `feedKey`'s own fallback is -- see "a row
    // missing a sort column sorts LAST" above. These three columns are NOT
    // NULL on `chain_detail_account_events`, but this fold takes
    // `Record<string, unknown>` and the lakehouse's copy of the same table
    // permits null in every one of them. A missing column must not throw and
    // must not silently become NaN, which would poison every later min/max in
    // its group.
    const queries: string[] = [];
    const card = await postFoldGroupsForTest({
      env: store(FOLD_FLOOR - 90 * 60_000, [
        {
          event_kind: "StakeAdded",
          netuid: 7,
          block_number: 900,
          observed_at: Date.parse("2026-08-15T18:00:00.000Z"),
        },
        // Same group, and carrying neither sort column.
        { event_kind: "StakeAdded", netuid: 7 },
      ]),
      queries,
    });
    assert.equal(queries.length, 0);
    assert.ok("agg" in card, "the card declined");
    const stake = card.kinds.find((k) => k.kind === "StakeAdded");
    assert.ok(stake, "the group survived");
    assert.equal(Number(stake.count), 2, "both rows counted");
    assert.ok(
      Number.isFinite(Number(card.scanned)),
      "a missing column must not turn the total into NaN",
    );
  });

  test("AN UNREADABLE STORE falls back rather than declining", async () => {
    const queries: string[] = [];
    const probe = await headProbeForTest({
      env: store(null, []),
      queries,
      floorMs: FOLD_FLOOR,
    });
    assert.ok(probe !== undefined);
    assert.ok(queries.length >= 1, "expected the R2 SQL probes");
  });
});

/** Drive the card down to its head-probe leg, recording any R2 SQL it issues. */
async function headProbeForTest(input: {
  env: Record<string, unknown>;
  queries: string[];
  floorMs: number;
}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    input.queries.push(String(JSON.parse(String(init.body)).query));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows: [] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const out = await loadAccountSummaryColdTier(
      {
        ...input.env,
        R2_SQL_TOKEN: "cfut_test",
        // The projection is what produces the fold floor the probe bounds on;
        // without it the card never reaches this leg at all.
        ...cardArchive(),
      } as never,
      SS58,
      { recentLimit: 2 },
    );
    return "recent" in out ? (out.recent ?? []) : [];
  } finally {
    globalThis.fetch = original;
  }
}

/** Drive the card down to its post-fold aggregate leg, returning the card. */
async function postFoldGroupsForTest(input: {
  env: Record<string, unknown>;
  queries: string[];
}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    input.queries.push(String(JSON.parse(String(init.body)).query));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows: [] } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const out = await loadAccountSummaryColdTier(
      { ...input.env, R2_SQL_TOKEN: "cfut_test", ...cardArchive() } as never,
      SS58,
      { recentLimit: 2 },
    );
    return out;
  } finally {
    globalThis.fetch = original;
  }
}
