// One subnet's event-kind summary, served from the lakehouse (#9303).
//
// `/api/v1/subnets/{netuid}/event-summary` reported `total_events: 0` for
// EVERY netuid probed -- 1, 8, 19 and 64 all answered zero -- while
// `/subnets/{netuid}/events` served real rows off the same `account_events`
// stream. Two views of one stream, opposite answers.
//
// The trap this file pins is the SHAPE of the distinct counts. The natural
// port is one grouped rollup with two `count(DISTINCT …)` columns, and R2 SQL
// rejects it at this route's own default window with `40015 ... count(DISTINCT)
// with GROUP BY` -- so unlike every other instance of this bug in the repo,
// adding a GROUP BY is not the fix. Each distinct has to be distributed into
// its own nested aggregation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { loadSubnetEventSummaryColdTier } from "../src/subnet-event-summary-cold-tier.ts";

type Row = Record<string, unknown>;

const NOW = 1_785_700_000_000;

/** Two kinds, chosen because they differ in exactly the way the merge has to
 * survive: WeightsSet carries no hotkey and no coldkey, StakeAdded carries
 * both. */
const BASE: Row[] = [
  {
    event_kind: "WeightsSet",
    event_count: 9832,
    first_block: 8_550_095,
    last_block: 8_765_613,
    first_observed_at: NOW - 2_000_000,
    last_observed_at: NOW,
  },
  {
    event_kind: "StakeAdded",
    event_count: 8517,
    first_block: 8_550_115,
    last_block: 8_765_646,
    first_observed_at: NOW - 2_000_000,
    last_observed_at: NOW,
    amount_tao: "1234.5",
  },
];
// WeightsSet IS present in the actor read and absent from the coldkey one --
// the asymmetry is the point. Its rows carry no hotkey and no coldkey, but the
// chain event does emit a uid, so the actor identity falls back to that and
// counts real setters; there is no delegating account to fall back to for
// coldkey, so it drops out entirely. Measured live for netuid 64/30d: 15
// setters against 9,830 WeightsSet events.
const HOTKEYS: Row[] = [
  { event_kind: "StakeAdded", n: 66 },
  { event_kind: "WeightsSet", n: 15 },
];
const COLDKEYS: Row[] = [{ event_kind: "StakeAdded", n: 2109 }];
const RECENT: Row[] = [
  {
    block_number: 8_765_646,
    event_index: 3,
    event_kind: "StakeAdded",
    netuid: 64,
    observed_at: NOW,
  },
];

/**
 * Answers the four reads by the clause only each one carries.
 *
 * `GROUP BY event_kind` is deliberately NOT a discriminator -- three of the
 * four queries contain it, so selecting on it would answer one fixture to
 * several different questions.
 */
function fakeEngine(
  overrides: {
    base?: Row[] | null;
    hotkeys?: Row[] | null;
    coldkeys?: Row[] | null;
    recent?: Row[] | null;
  } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (sql.includes("ORDER BY")) return pick(overrides.recent, RECENT);
    if (sql.includes("AS actor")) return pick(overrides.hotkeys, HOTKEYS);
    if (sql.includes("GROUP BY event_kind, coldkey"))
      return pick(overrides.coldkeys, COLDKEYS);
    return pick(overrides.base, BASE);
  };
  return {
    query,
    seen,
    base: () => seen.find((s) => s.includes("count(*) AS event_count"))!,
    hotkeys: () => seen.find((s) => s.includes("AS actor"))!,
    coldkeys: () =>
      seen.find((s) => s.includes("GROUP BY event_kind, coldkey"))!,
    recent: () => seen.find((s) => s.includes("ORDER BY"))!,
  };
}

const load = (engine: ReturnType<typeof fakeEngine>, netuid = 64, opts = {}) =>
  loadSubnetEventSummaryColdTier({} as never, netuid, {
    window: "30d",
    limit: 10,
    query: engine.query as never,
    ...opts,
  });

describe("loadSubnetEventSummaryColdTier", () => {
  test("builds the summary from the per-kind rollup", async () => {
    const engine = fakeEngine();
    const data = await load(engine);
    assert.ok(data);
    assert.equal(data.netuid, 64);
    assert.equal(data.window, "30d");
    assert.equal(data.total_events, 9832 + 8517);
    assert.equal(data.kind_count, 2);
    assert.equal(data.recent_event_count, 1);
  });

  test("no query anywhere uses COUNT(DISTINCT), grouped or not", async () => {
    // The whole reason this reader has four queries instead of one. R2 SQL
    // rejects two grouped distincts in a single scan at the 30d default:
    //
    //   40015: scan budget exceeded: scanning too much data for
    //   count(DISTINCT), count(DISTINCT) with GROUP BY
    //
    // and this route also offers 90d, three times the span that already fails.
    const engine = fakeEngine();
    await load(engine, 64, { window: "90d" });
    for (const sql of engine.seen) {
      assert.doesNotMatch(
        sql,
        /count\(\s*DISTINCT/i,
        `R2 SQL rejects this at this route's own windows: ${sql.slice(0, 130)}`,
      );
    }
  });

  test("each distinct is distributed into its own nested GROUP BY", async () => {
    const engine = fakeEngine();
    await load(engine);
    assert.match(
      engine.hotkeys(),
      /count\(\*\) AS n FROM \(SELECT event_kind, CASE .* AS actor FROM chain\.account_events .*GROUP BY event_kind, CASE .*\) WHERE actor IS NOT NULL GROUP BY event_kind/,
    );
    assert.match(
      engine.coldkeys(),
      /count\(\*\) AS n FROM \(SELECT event_kind, coldkey FROM chain\.account_events .*GROUP BY event_kind, coldkey\) GROUP BY event_kind/,
    );
  });

  test("the actor count falls back to uid, or WeightsSet reports zero setters", async () => {
    // THE BUG THIS REPLACED. Counting `hotkey` alone reported hotkey_count 0
    // beside a five-figure event_count for WeightsSet -- the highest-volume
    // kind on most subnets -- because the chain event emits [netuid, uid] and
    // no hotkey at all. Live, netuid 64/30d: 9,830 events credited to 0
    // setters, against a real 15. A confident zero, which is exactly what this
    // reader exists to stop publishing.
    //
    // The retired Postgres route counted this same hotkey-or-uid identity for
    // the same stated reason, as do the weight-setter leaderboards.
    const engine = fakeEngine();
    await load(engine);
    assert.match(engine.hotkeys(), /WHEN uid IS NOT NULL/);
    assert.match(engine.hotkeys(), /'uid:'/);
    assert.doesNotMatch(
      engine.hotkeys(),
      /GROUP BY event_kind, hotkey\)/,
      "grouping on hotkey alone is the zero-setter bug",
    );
  });

  test("the distinct reads exclude NULL keys, or every kind gains a phantom", async () => {
    // COUNT(DISTINCT col) ignores NULLs; GROUP BY col yields a NULL GROUP. The
    // actor read filters the composite value AFTER grouping (a row with
    // neither hotkey nor uid collapses to a NULL actor); the coldkey read
    // filters the column directly. Without either, a kind carrying none of that
    // key would report exactly one participant that does not exist.
    const engine = fakeEngine();
    await load(engine);
    assert.match(engine.hotkeys(), /WHERE actor IS NOT NULL/);
    assert.match(engine.coldkeys(), /coldkey IS NOT NULL/);
  });

  test("merges the distinct counts onto the right kinds, and zeroes the rest", async () => {
    // The merge is by event_kind across three independent result sets of
    // different lengths. A kind absent from a distinct read has genuinely zero
    // of that key -- not an unknown to be dropped.
    const engine = fakeEngine();
    const data = await load(engine);
    const byKind = Object.fromEntries(
      data!.event_kinds.map((k) => [k.event_kind, k]),
    );
    assert.equal(byKind.StakeAdded.hotkey_count, 66);
    assert.equal(byKind.StakeAdded.coldkey_count, 2109);
    assert.equal(
      byKind.WeightsSet.hotkey_count,
      15,
      "WeightsSet has no hotkey but does have uids -- its setters must be counted, never StakeAdded's 66",
    );
    // Still zero here, and genuinely so: a WeightsSet has no delegating
    // account, so there is nothing for the coldkey count to fall back to.
    assert.equal(byKind.WeightsSet.coldkey_count, 0);
  });

  test("scopes every read to the subnet and the window", async () => {
    const engine = fakeEngine();
    await load(engine, 7);
    for (const sql of engine.seen) {
      assert.match(sql, /netuid = 7/, `unscoped read: ${sql.slice(0, 90)}`);
      assert.match(sql, /observed_at >= \d+/);
    }
    const cutoff = Number(/observed_at >= (\d+)/.exec(engine.base())![1]);
    const days = (Date.now() - cutoff) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1, `expected ~30d, got ${days}d`);
  });

  test("an empty window is a measured zero, not a decline", async () => {
    // `query` returns null on failure and [] on a successful empty scan. A
    // quiet subnet must be able to say so -- declining here would make it
    // indistinguishable from the broken tier this fixes.
    const engine = fakeEngine({
      base: [],
      hotkeys: [],
      coldkeys: [],
      recent: [],
    });
    const data = await load(engine);
    assert.ok(data, "an empty scan is an answer");
    assert.equal(data.total_events, 0);
    assert.equal(data.kind_count, 0);
  });

  test("declines when any of the four reads misses", async () => {
    for (const miss of [
      { base: null },
      { hotkeys: null },
      { coldkeys: null },
      { recent: null },
    ]) {
      const engine = fakeEngine(miss);
      assert.equal(
        await load(engine),
        null,
        `${JSON.stringify(miss)} must decline -- a summary pairing real counts ` +
          "with zeroed participants reads as measured fact",
      );
    }
  });

  test("an unusable limit resolves to the route default, it does not decline", async () => {
    // The limit only caps the recent-events page; a garbage value should still
    // yield the default page rather than an empty card.
    for (const limit of [0, -5, 1.5, Number.NaN]) {
      const engine = fakeEngine();
      const data = await load(engine, 64, { limit });
      assert.ok(data, `limit ${limit} should fall back, not decline`);
      assert.match(engine.recent(), /LIMIT 10/);
    }
  });

  test("a distinct row with no usable kind is dropped, not keyed as undefined", async () => {
    // Keying it under String(undefined) would attach a real participant count
    // to a kind called "undefined" -- and, worse, could collide with a genuine
    // kind if the merge ever loosened.
    const engine = fakeEngine({
      hotkeys: [
        { event_kind: null, n: 999 },
        { event_kind: "", n: 888 },
        { event_kind: "StakeAdded", n: 66 },
      ],
    });
    const data = await load(engine);
    const byKind = Object.fromEntries(
      data!.event_kinds.map((k) => [k.event_kind, k]),
    );
    assert.equal(byKind.StakeAdded.hotkey_count, 66);
    assert.equal(byKind.WeightsSet.hotkey_count, 0, "no phantom carried over");
    assert.equal(Object.keys(byKind).length, 2, "no 'undefined'/'' kind added");
  });

  test("refuses an unusable netuid rather than scanning every subnet", async () => {
    for (const netuid of [-1, 1.5, Number.NaN]) {
      const engine = fakeEngine();
      assert.equal(await load(engine, netuid), null, `netuid ${netuid}`);
      assert.equal(engine.seen.length, 0, "must not reach the engine");
    }
  });

  test("refuses a window the route does not offer", async () => {
    // Silently falling back to 30d would answer a different question than the
    // label echoed in the response.
    for (const window of ["all-time", "1y", ""]) {
      const engine = fakeEngine();
      assert.equal(await load(engine, 64, { window }), null, window);
      assert.equal(engine.seen.length, 0);
    }
  });

  test("an absent limit serves the route default rather than declining", async () => {
    // parseLimitParam types its result as `number | undefined`; a missing
    // ?limit= must serve the default page, not an empty card.
    const engine = fakeEngine();
    const data = await load(engine, 64, { limit: undefined });
    assert.ok(data);
    assert.match(engine.recent(), /LIMIT 10/);
  });
});

describe("all three event-summary surfaces go through the one reader", () => {
  // The regression is a surface wired to the lakehouse while its siblings are
  // not. A call site either exists or it does not.
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadSubnetEventSummaryColdTier", () => {
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadSubnetEventSummaryColdTier\(/,
        `${surface} (${path}) would answer a zeroed card while its siblings ` +
          "answer real numbers",
      );
    }
  });
});
