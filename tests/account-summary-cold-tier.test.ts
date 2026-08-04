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
// capped-scan probe must stay a separate read from the aggregate it qualifies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  foldSummaryGroups,
  loadAccountSummaryColdTier,
} from "../src/account-feeds-cold-tier.ts";
import {
  ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
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
  { block_number: 8_760_000, event_kind: "AxonServed", netuid: 55 },
];

/**
 * Answers each of the THREE reads by the shape of its SQL.
 *
 * Three, not five: the aggregate, the distinct-subnet count and the per-kind counts
 * all grouped the same CTE, so one `GROUP BY event_kind, netuid` yields all of them.
 * The other two cannot fold in -- the cap probe deliberately scans CAP+1 rows outside
 * the CTE, and the recent feed selects whole rows in a different order.
 */
function fakeEngine(
  overrides: {
    groups?: Row[] | null;
    probe?: Row[] | null;
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
    const answer = sql.includes("GROUP BY event_kind, netuid")
      ? pick(overrides.groups, GROUPS)
      : sql.includes("count(*) AS c FROM (")
        ? pick(overrides.probe, [{ c: 6 }])
        : pick(overrides.recent, RECENT);
    if (answer === null) {
      // Mirrors r2SqlQuery: the engine's own explanation is reported, then null.
      deps?.onError?.("r2 sql: HTTP 500 (stubbed failure)");
      errors.push(sql);
    }
    return answer;
  };
  return {
    query,
    seen,
    errors,
    probe: () => seen.find((s) => s.includes("count(*) AS c FROM ("))!,
    groups: () => seen.find((s) => s.includes("GROUP BY event_kind, netuid"))!,
  };
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

  test("three reads, not five", async () => {
    // The shape of the #9386 failure: five concurrent broad scans of an
    // unpartitioned table under Promise.all, so the success probability was the
    // PRODUCT of five. A single count(*) on account_events reports ~3,390 R2
    // requests, so each removed scan is real cost as well as real risk.
    const engine = fakeEngine();
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.equal(engine.seen.length, 3, engine.seen.join("\n").slice(0, 400));
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
      probe: [{ c: 8 }],
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
      probe: [{ c: 3 }],
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
      probe: [{ c: 2 }],
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
      probe: [{ c: 3 }],
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
      probe: [{ c: 2 }],
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

  test("the cap probe is a separate read over CAP + 1", async () => {
    // Reusing the aggregate's own count would make an account with EXACTLY CAP
    // events look capped, which nulls first_block/first_seen_at on a card whose
    // totals are in fact exact.
    const engine = fakeEngine();
    await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.match(
      engine.probe(),
      new RegExp(`LIMIT ${ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1}`),
      "the probe must look one row past the cap",
    );
    assert.match(
      engine.groups(),
      new RegExp(`LIMIT ${ACCOUNT_EVENT_SUMMARY_SCAN_CAP}`),
      "the aggregate window is the cap itself",
    );
  });

  test("exactly CAP events is complete; CAP + 1 is capped", async () => {
    for (const [scanned, capped] of [
      [ACCOUNT_EVENT_SUMMARY_SCAN_CAP, false],
      [ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1, true],
    ] as const) {
      const engine = fakeEngine({ probe: [{ c: scanned }] });
      const cold = await loadAccountSummaryColdTier({} as never, SS58, {
        query: engine.query as never,
      });
      const card = buildAccountSummary(SS58, cold as never);
      assert.equal(card.event_scan_capped, capped, `scanned=${scanned}`);
      // A capped window's minimum is a floor, not the account's first-ever.
      assert.equal(card.first_block === null, capped);
      assert.equal(card.first_seen_at === null, capped);
      // The newest end stays exact either way.
      assert.equal(card.last_block, AGG.lb);
    }
  });

  test("declines when any leg misses", async () => {
    // A card mixing measured aggregates with a zeroed probe would silently flip
    // event_scan_capped and publish a window floor as first_seen_at.
    for (const miss of [
      { groups: null },
      { probe: null },
      { recent: null },
      { probe: [] },
    ]) {
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
    const engine = fakeEngine({ groups: [], probe: [{ c: 0 }], recent: [] });
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
