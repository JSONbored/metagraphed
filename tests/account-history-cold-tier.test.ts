// One account's per-day activity series, computed from the lakehouse (#9315).
//
// `/api/v1/accounts/{ss58}/history` returned `day_count: 0` for every account,
// including hotkeys whose own `/events` feed is busy, because the Postgres tier
// that owned `account_events_daily` is gone and nothing replaced it.
//
// Two decisions this file pins, both of which a smaller diff would have gotten
// wrong:
//
//  1. The series is COMPUTED from `chain.account_events`, not read from
//     `chain.account_events_daily` -- that table exists in the lakehouse but is
//     a frozen export ending 2026-07-15, so reading it would answer "this
//     account did nothing since July" as though it were measured.
//  2. The event kinds come from a SECOND query. The retired writer used
//     `string_agg(DISTINCT event_kind, ',')`, which R2 SQL rejects at this
//     scale with the same `40015` scan-budget error that kills
//     `count(DISTINCT)`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { loadAccountHistoryColdTier } from "../src/account-history-cold-tier.ts";

type Row = Record<string, unknown>;

const SS58 = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

/** The engine returns a full timestamp for a truncated day. */
const ts = (day: string) => `${day}T00:00:00.000000000Z`;

const DAYS: Row[] = [
  {
    day: ts("2026-08-03"),
    netuid: 64,
    event_count: 72,
    first_block: 8_759_894,
    last_block: 8_765_497,
  },
  {
    day: ts("2026-08-03"),
    netuid: 18,
    event_count: 39,
    first_block: 8_760_210,
    last_block: 8_765_627,
  },
  {
    day: ts("2026-08-02"),
    netuid: 64,
    event_count: 12,
    first_block: 8_750_000,
    last_block: 8_755_000,
  },
];
const KINDS: Row[] = [
  { day: ts("2026-08-03"), netuid: 64, event_kind: "StakeAdded" },
  { day: ts("2026-08-03"), netuid: 64, event_kind: "WeightsSet" },
  { day: ts("2026-08-03"), netuid: 18, event_kind: "StakeRemoved" },
  { day: ts("2026-08-02"), netuid: 64, event_kind: "StakeAdded" },
];

/**
 * Answers the two reads by the clause only each carries.
 *
 * `GROUP BY` is not a discriminator -- both queries have one. The kinds read is
 * the one that selects `event_kind`; the page read is the one that counts.
 */
function fakeEngine(
  overrides: { days?: Row[] | null; kinds?: Row[] | null } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    return sql.includes("count(*) AS event_count")
      ? pick(overrides.days, DAYS)
      : pick(overrides.kinds, KINDS);
  };
  return {
    query,
    seen,
    page: () => seen.find((s) => s.includes("count(*) AS event_count"))!,
    kinds: () => seen.find((s) => s.includes("event_kind"))!,
  };
}

const load = (engine: ReturnType<typeof fakeEngine>, query = {}) =>
  loadAccountHistoryColdTier(
    {} as never,
    SS58,
    { limit: 100, ...query },
    { queryFn: engine.query as never },
  );

describe("loadAccountHistoryColdTier", () => {
  test("builds the day series, newest day first", async () => {
    const engine = fakeEngine();
    const data = await load(engine);
    assert.ok(data);
    assert.equal(data.day_count, 3);
    assert.equal(data.days[0].day, "2026-08-03");
    assert.equal(data.days[0].netuid, 64);
    assert.equal(data.days[0].event_count, 72);
    assert.equal(data.days[0].first_block, 8_759_894);
  });

  test("the day is published as YYYY-MM-DD, not the engine's timestamp", async () => {
    // The cursor encodes it as 20260803 and ?from/?to compare against it, so
    // leaking `2026-08-03T00:00:00.000000000Z` would break both.
    const engine = fakeEngine();
    const data = await load(engine);
    for (const d of data!.days) {
      assert.match(String(d.day), /^\d{4}-\d{2}-\d{2}$/, `bad day ${d.day}`);
    }
  });

  test("no query uses string_agg or COUNT(DISTINCT)", async () => {
    // The retired writer rolled the kinds up with
    // `string_agg(DISTINCT event_kind, ',')`. R2 SQL rejects that outright:
    //
    //   40015: scan budget exceeded: scanning too much data for
    //   string_agg(DISTINCT) with GROUP BY
    //
    // and a rejected query declines the reader, which is the bug this fixes.
    const engine = fakeEngine();
    await load(engine);
    for (const sql of engine.seen) {
      assert.doesNotMatch(sql, /string_agg/i, sql.slice(0, 120));
      assert.doesNotMatch(sql, /count\(\s*DISTINCT/i, sql.slice(0, 120));
    }
  });

  test("joins the kinds onto the right day and subnet", async () => {
    // The join key is (day, netuid) across two independent result sets. Getting
    // it wrong would attribute one subnet's activity to another on the same day.
    const engine = fakeEngine();
    const data = await load(engine);
    const byKey = Object.fromEntries(
      data!.days.map((d) => [`${d.day}|${d.netuid}`, d.event_kinds]),
    );
    assert.deepEqual(byKey["2026-08-03|64"], ["StakeAdded", "WeightsSet"]);
    assert.deepEqual(byKey["2026-08-03|18"], ["StakeRemoved"]);
    assert.deepEqual(byKey["2026-08-02|64"], ["StakeAdded"]);
  });

  test("a cell with no kinds yields an empty array, never a phantom entry", async () => {
    const engine = fakeEngine({ kinds: [] });
    const data = await load(engine);
    assert.equal(data!.day_count, 3);
    for (const d of data!.days) assert.deepEqual(d.event_kinds, []);
  });

  test("the kinds read is bounded to the page's own days", async () => {
    // A busy validator has ~216,000 (day, netuid, kind) groups all-time. Asking
    // for them unbounded to annotate a 100-row page would scan the entire
    // history on every request.
    const engine = fakeEngine();
    await load(engine);
    const kinds = engine.kinds();
    const bounds = [...kinds.matchAll(/observed_at (>=|<) (\d+)/g)];
    assert.equal(bounds.length, 2, `expected a day-range bound: ${kinds}`);
    const lo = Number(bounds[0]![2]);
    const hi = Number(bounds[1]![2]);
    assert.equal(lo, Date.parse("2026-08-02T00:00:00.000Z"));
    assert.equal(
      hi,
      Date.parse("2026-08-04T00:00:00.000Z"),
      "?to is inclusive",
    );
  });

  test("an empty page issues no kinds query at all", async () => {
    // There is nothing to annotate, and the unbounded scan would be the whole
    // account history.
    const engine = fakeEngine({ days: [] });
    const data = await load(engine);
    assert.ok(data);
    assert.equal(data.day_count, 0);
    assert.equal(engine.seen.length, 1, "the kinds read must not be issued");
  });

  test("is hotkey-attributed, matching the retired rollup and the contract", async () => {
    // /events matches hotkey OR coldkey; this route documents that it does not.
    // Widening it would make the route disagree with every historical answer.
    const engine = fakeEngine();
    await load(engine);
    for (const sql of engine.seen) {
      assert.match(sql, new RegExp(`hotkey = '${SS58}'`));
      assert.doesNotMatch(sql, /coldkey/);
      assert.match(sql, /netuid IS NOT NULL/);
    }
  });

  test("forwards the netuid and date filters into SQL", async () => {
    const engine = fakeEngine();
    await load(engine, { netuid: 7, from: "2026-07-01", to: "2026-07-31" });
    const page = engine.page();
    assert.match(page, /netuid = 7/);
    assert.match(
      page,
      new RegExp(`observed_at >= ${Date.parse("2026-07-01T00:00:00.000Z")}`),
    );
    assert.match(
      page,
      new RegExp(`observed_at < ${Date.parse("2026-08-01T00:00:00.000Z")}`),
      "?to is INCLUSIVE of its day, so the bound is that day's end",
    );
  });

  test("a cursor seeks past the exact (day, netuid) it names", async () => {
    // SQL can only bound the cursor to whole DAYS -- the tuple's halves sit on
    // opposite sides of the aggregation -- so the cursor's own day arrives
    // complete and its already-seen subnets are dropped here. netuid DESC means
    // "seen" is >= the cursor's.
    const engine = fakeEngine();
    const data = await load(engine, { cursor: "20260803.64" });
    assert.match(
      engine.page(),
      new RegExp(`observed_at < ${Date.parse("2026-08-04T00:00:00.000Z")}`),
    );
    assert.deepEqual(
      data!.days.map((d) => `${d.day}|${d.netuid}`),
      ["2026-08-03|18", "2026-08-02|64"],
      "netuid 64 on the cursor's own day was already served",
    );
  });

  test("a malformed cursor means page 1, it does not throw or decline", async () => {
    // data-api's never-throw contract: an unusable token falls back rather than
    // erroring, so a stale client keeps working.
    for (const cursor of ["garbage", "1.2.3", "", "20261332.5"]) {
      const engine = fakeEngine();
      const data = await load(engine, { cursor });
      assert.ok(data, `cursor ${cursor} must not decline`);
      assert.equal(data.day_count, 3);
    }
  });

  test("next_cursor is emitted only on a FULL page", async () => {
    // A short page ends the series; emitting a token there would make a client
    // request a page that is always empty.
    const short = await load(fakeEngine());
    assert.equal(short!.next_cursor, null, "3 rows against limit 100");

    const engine = fakeEngine();
    const full = await load(engine, { limit: 3 });
    assert.equal(full!.next_cursor, "20260802.64", "the last row's own token");
  });

  test("drops engine rows whose day is unusable, rather than publishing them", async () => {
    // The day is the series' primary key and the cursor's first half. A row
    // whose day is a number, a non-date string, or a well-formed impossible
    // date cannot be keyed or paged, so it is dropped rather than surfaced.
    const engine = fakeEngine({
      days: [
        { day: 12_345, netuid: 1, event_count: 5 },
        { day: "not-a-date", netuid: 2, event_count: 5 },
        ...DAYS,
      ],
    });
    const data = await load(engine);
    assert.equal(data!.day_count, 3, "only the three usable rows survive");
    for (const d of data!.days) {
      assert.match(String(d.day), /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("declines when a page day passes the shape check but is not a real date", async () => {
    // `2026-13-45` matches YYYY-MM-DD and is still not a date, so it cannot
    // bound the kinds read. Declining beats issuing an unbounded scan.
    const engine = fakeEngine({
      days: [{ day: ts("2026-13-45"), netuid: 1, event_count: 5 }],
    });
    assert.equal(await load(engine), null);
  });

  test("skips a kinds row with no usable day or kind", async () => {
    const engine = fakeEngine({
      kinds: [
        { day: 999, netuid: 64, event_kind: "Ghost" },
        { day: ts("2026-08-03"), netuid: 64, event_kind: "" },
        { day: ts("2026-08-03"), netuid: 64, event_kind: null },
        { day: ts("2026-08-03"), netuid: 64, event_kind: "StakeAdded" },
      ],
    });
    const data = await load(engine);
    const first = data!.days.find(
      (d) => d.netuid === 64 && d.day === "2026-08-03",
    );
    assert.deepEqual(
      first!.event_kinds,
      ["StakeAdded"],
      "no empty/ghost kinds",
    );
  });

  test("offset skips days without a cursor, and the page still caps at limit", async () => {
    // ?offset is the deprecated fallback the contract still honours. R2 SQL has
    // no OFFSET, so the reader over-fetches and slices here.
    const engine = fakeEngine();
    const data = await load(engine, { limit: 1, offset: 1 });
    assert.equal(data!.day_count, 1);
    assert.equal(data!.days[0].netuid, 18, "the second row, not the first");
    assert.match(engine.page(), /LIMIT 2/, "limit + offset is fetched");
  });

  test("a cursor page tolerates a row whose netuid is unusable", async () => {
    // The tuple's second half comes from engine data. A row that cannot supply
    // it sorts before every real netuid rather than throwing or being kept.
    const engine = fakeEngine({
      days: [{ day: ts("2026-08-03"), netuid: null, event_count: 5 }, ...DAYS],
    });
    const data = await load(engine, { cursor: "20260803.64" });
    assert.ok(data);
    assert.ok(
      data.days.every((d) => !(d.day === "2026-08-03" && d.netuid === 64)),
      "the cursor's own cell is still excluded",
    );
  });

  test("declines when either read misses", async () => {
    for (const miss of [{ days: null }, { kinds: null }]) {
      const engine = fakeEngine(miss);
      assert.equal(
        await load(engine),
        null,
        `${JSON.stringify(miss)} must decline so the caller keeps its fallback`,
      );
    }
  });

  test("refuses an unusable address rather than scanning every account", async () => {
    for (const bad of ["", "not-an-address", "0x1234"]) {
      const engine = fakeEngine();
      assert.equal(
        await loadAccountHistoryColdTier(
          {} as never,
          bad,
          { limit: 10 },
          { queryFn: engine.query as never },
        ),
        null,
      );
      assert.equal(engine.seen.length, 0, "must not reach the engine");
    }
  });

  test("refuses an unusable limit or filter value", async () => {
    for (const query of [
      { limit: 0 },
      { limit: -1 },
      { limit: 10, netuid: "abc" },
      { limit: 10, from: "not-a-date" },
      { limit: 10, to: "2026-13-45" },
    ]) {
      const engine = fakeEngine();
      assert.equal(await load(engine, query), null, JSON.stringify(query));
      assert.equal(engine.seen.length, 0);
    }
  });
});

describe("all three history surfaces reach the lakehouse", () => {
  test("REST calls the reader and MCP/GraphQL go through the shared loader", () => {
    assert.match(
      readFileSync("workers/request-handlers/entities.ts", "utf8"),
      /loadAccountHistoryColdTier\(/,
      "REST would answer a zeroed series",
    );
    // MCP and GraphQL both call loadAccountHistory, which is now the thing that
    // reaches the lakehouse -- so wiring it once covers both.
    const shared = readFileSync("src/account-events.ts", "utf8");
    assert.match(shared, /loadAccountHistoryColdTier\(/);
    for (const path of ["src/mcp-server.ts", "src/graphql.ts"]) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadAccountHistory\(\s*(ctx|context)\.env,/,
        `${path} must pass env, or the loader cannot reach the lakehouse`,
      );
    }
  });
});
