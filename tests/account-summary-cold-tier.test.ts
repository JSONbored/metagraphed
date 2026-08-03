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
import { loadAccountSummaryColdTier } from "../src/account-feeds-cold-tier.ts";
import {
  ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
  buildAccountSummary,
} from "../src/account-events.ts";

type Row = Record<string, unknown>;

const SS58 = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

const AGG = {
  c: 6,
  sc: 2,
  fb: 8_700_000,
  lb: 8_760_000,
  fo: 1_784_000_000_000,
  lo: 1_785_000_000_000,
};
const KINDS = [
  { kind: "AxonServed", count: 4 },
  { kind: "NeuronRegistered", count: 2 },
];
const RECENT = [
  { block_number: 8_760_000, event_kind: "AxonServed", netuid: 55 },
];

/** Answers each of the four reads by the shape of its SQL. */
function fakeEngine(
  overrides: {
    agg?: Row[] | null;
    kinds?: Row[] | null;
    probe?: Row[] | null;
    recent?: Row[] | null;
  } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (sql.includes("GROUP BY event_kind"))
      return pick(overrides.kinds, KINDS);
    if (sql.includes("count(DISTINCT netuid)"))
      return pick(overrides.agg, [AGG]);
    if (sql.includes("count(*) AS c FROM ("))
      return pick(overrides.probe, [{ c: 6 }]);
    return pick(overrides.recent, RECENT);
  };
  return {
    query,
    seen,
    probe: () => seen.find((s) => s.includes("count(*) AS c FROM ("))!,
    agg: () => seen.find((s) => s.includes("count(DISTINCT netuid)"))!,
  };
}

describe("loadAccountSummaryColdTier", () => {
  test("returns the four halves the summary builder composes", async () => {
    const engine = fakeEngine();
    const cold = await loadAccountSummaryColdTier({} as never, SS58, {
      query: engine.query as never,
    });
    assert.ok(cold);
    const card = buildAccountSummary(SS58, cold);
    assert.equal(card.event_count, 6);
    assert.equal(card.subnet_count, 2);
    assert.equal(card.event_kinds.length, 2);
    assert.equal(card.recent_events.length, 1);
    assert.equal(card.event_scan_capped, false);
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
      engine.agg(),
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
      const card = buildAccountSummary(SS58, cold!);
      assert.equal(card.event_scan_capped, capped, `scanned=${scanned}`);
      // A capped window's minimum is a floor, not the account's first-ever.
      assert.equal(card.first_block === null, capped);
      assert.equal(card.first_seen_at === null, capped);
      // The newest end stays exact either way.
      assert.equal(card.last_block, AGG.lb);
    }
  });

  test("declines when any half misses", async () => {
    // A card mixing measured aggregates with a zeroed probe would silently flip
    // event_scan_capped and publish a window floor as first_seen_at.
    for (const miss of [
      { agg: null },
      { kinds: null },
      { probe: null },
      { recent: null },
      { agg: [] },
      { probe: [] },
    ]) {
      const engine = fakeEngine(miss);
      assert.equal(
        await loadAccountSummaryColdTier({} as never, SS58, {
          query: engine.query as never,
        }),
        null,
        `${JSON.stringify(miss)} must decline`,
      );
    }
  });

  test("an unusable address declines rather than scanning every account", async () => {
    for (const bad of ["", "not-an-address", "'; DROP TABLE x --"]) {
      const engine = fakeEngine();
      assert.equal(
        await loadAccountSummaryColdTier({} as never, bad, {
          query: engine.query as never,
        }),
        null,
      );
      assert.equal(engine.seen.length, 0, "must not reach the engine at all");
    }
  });

  test("an unusable recent limit declines", async () => {
    for (const recentLimit of [0, -1, 1.5]) {
      const engine = fakeEngine();
      assert.equal(
        await loadAccountSummaryColdTier({} as never, SS58, {
          recentLimit,
          query: engine.query as never,
        }),
        null,
        `recentLimit ${recentLimit}`,
      );
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
