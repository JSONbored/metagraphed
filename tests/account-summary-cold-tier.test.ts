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
import { visibleInWindow } from "./helpers/scan-window.ts";
import {
  ACCOUNT_SUMMARY_POINTER_KEY,
  accountSummaryShardKey,
} from "../src/account-summary-projection.ts";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  foldSummaryGroups,
  loadAccountSummaryColdTier,
  mergeNewestEvents,
} from "../src/account-feeds-cold-tier.ts";
import {
  ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
  ACCOUNT_SUMMARY_RECENT_LIMIT,
  buildAccountSummary,
} from "../src/account-events.ts";

type Row = Record<string, unknown>;

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
                accounts: { [SS58]: groupsSummingTo(6) },
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

  test("no published recent list falls back to the walk, unchanged", async () => {
    // Every generation before metagraphed-infra#575 lands here, and the route
    // must behave exactly as it did -- the aggregate leg still short-circuits.
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier(archive(null), SS58, {
      query: engine.query as never,
    });
    assert.equal(cold.declined, undefined);
    const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
    assert.ok(feed.length >= 1);
    assert.equal(
      feed.some((s) => s.includes(`observed_at >= ${FLOOR}`)),
      false,
      "no floor is placed without a published list to meet it",
    );
  });

  test("a published limit under the caller's need falls back too", async () => {
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier(
      archive([event()], { limit: ACCOUNT_SUMMARY_RECENT_LIMIT - 1 }),
      SS58,
      { query: engine.query as never },
    );
    assert.equal(cold.declined, undefined);
    const feed = engine.seen.filter((s) => !s.includes("GROUP BY"));
    assert.equal(
      feed.some((s) => s.includes(`observed_at >= ${FLOOR}`)),
      false,
    );
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

  test("either half may be empty", () => {
    assert.deepEqual(mergeNewestEvents([], [], 10), []);
    assert.equal(mergeNewestEvents([row(1, 1)], [], 10).length, 1);
    assert.equal(mergeNewestEvents([], [row(1, 1)], 10).length, 1);
  });
});
