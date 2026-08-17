// The all-events feed reader (#9146).
//
// The property that matters most here is PAGING COMPLETENESS. Each page reads
// one bounded block window, so a short page does NOT mean the feed is
// exhausted -- a sparse pallet/method filter can match nothing in one window
// and plenty below it. If a short page stopped emitting a continuation the
// feed would be silently truncated, which looks exactly like "no more events".
// That case gets its own tests.

import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { loadChainEventsHeadHotTier } from "../src/chain-detail-hot-tier.ts";

// The head leg reads `chain_detail_chain_events` through src/read-store.ts,
// which builds `new Client(...)` itself -- so the module is the seam. See
// tests/helpers/pg-mock.ts for why the controller is hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import {
  CHAIN_EVENTS_BLOCK_WINDOW,
  CHAIN_EVENTS_STATS_BLOCKS_DEFAULT,
  CHAIN_EVENTS_STATS_BLOCKS_MAX,
  loadChainEventsColdTier,
  loadChainEventsStatsColdTier,
  loadSubnetLeaseHistoryColdTier,
} from "../src/chain-events-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { chainEventsQueryError } from "../src/chain-events-cold-tier.ts";
import { ChainEventsFeedArtifactSchema } from "../schemas-src/routes/chain-events.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import {
  decodeWatermarkKey,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env;

function eventRow(block: number, index: number) {
  return {
    block_number: block,
    event_index: index,
    pallet: "SubtensorModule",
    method: "NeuronRegistered",
    args: '{"netuid":[1]}',
    phase: "ApplyExtrinsic",
    extrinsic_index: 3,
    observed_at: 1_785_708_540_000 - index,
  };
}

function sqlFetch(...responses: unknown[][]) {
  const queries: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    const rows = responses[Math.min(call, responses.length - 1)] ?? [];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

describe("loadChainEventsColdTier", () => {
  test("bounds page one to a block window below the seam", async () => {
    // Unbounded this query scans ~2 GB; the floor is what makes the route
    // affordable. Ordering is block-first because the lakehouse prunes on
    // block_number, NOT observed_at like the TimescaleDB original.
    const q = sqlFetch([eventRow(8_759_336, 5)]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 50 });
    assert.ok(page);
    assert.match(q[0]!, /FROM chain\.chain_events/);
    assert.match(
      q[0]!,
      new RegExp(
        `block_number >= ${DEFAULT_BLOCKS_SEAM - CHAIN_EVENTS_BLOCK_WINDOW}`,
      ),
    );
    assert.match(q[0]!, new RegExp(`block_number <= ${DEFAULT_BLOCKS_SEAM}`));
    assert.match(q[0]!, /ORDER BY block_number DESC, event_index DESC/);
    assert.doesNotMatch(q[0]!, /ORDER BY observed_at/);
  });

  test("a SHORT page still hands back a continuation, not an end-of-feed", async () => {
    // The whole risk of a windowed feed: a filter that matches nothing in this
    // window has matches deeper. Reporting no continuation would truncate the
    // feed silently.
    sqlFetch([]);
    const page = await loadChainEventsColdTier(TOKEN, {
      limit: 50,
      pallet: "Crowdloan",
    });
    assert.equal(page!.count, 0);
    assert.equal(page!.next_cursor, null);
    assert.equal(
      page!.next_before,
      DEFAULT_BLOCKS_SEAM - CHAIN_EVENTS_BLOCK_WINDOW,
      "must anchor at the window floor so the caller walks to the next window",
    );
  });

  test("walks to the next window when given the short page's before", async () => {
    const floor = DEFAULT_BLOCKS_SEAM - CHAIN_EVENTS_BLOCK_WINDOW;
    const q = sqlFetch([]);
    await loadChainEventsColdTier(TOKEN, { limit: 50, before: floor });
    // The next window sits strictly below the previous floor.
    assert.match(q[0]!, new RegExp(`block_number <= ${floor - 1}`));
    assert.match(
      q[0]!,
      new RegExp(`block_number >= ${floor - 1 - CHAIN_EVENTS_BLOCK_WINDOW}`),
    );
  });

  test("stops only at genesis", async () => {
    sqlFetch([]);
    const page = await loadChainEventsColdTier(TOKEN, {
      limit: 50,
      before: 10,
    });
    // Window floor clamps to 0, so there is nothing below to walk to.
    assert.equal(page!.next_before, null, "block 0 genuinely ends the feed");
  });

  test("a before of 0 has nothing below it and answers empty without querying", async () => {
    // ceiling = -1: there is no window below genesis, so this must be an
    // empty ANSWER rather than a decline or a query for a negative range.
    const q = sqlFetch([eventRow(1, 0)]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 5, before: 0 });
    assert.deepEqual(page, {
      count: 0,
      next_before: null,
      next_cursor: null,
      events: [],
    });
    assert.equal(q.length, 0, "must not issue a query at all");
  });

  test("a full page emits the 3-part cursor and seeks with it", async () => {
    const rows = [eventRow(8_759_336, 5), eventRow(8_759_336, 4)];
    sqlFetch(rows);
    const first = await loadChainEventsColdTier(TOKEN, { limit: 2 });
    assert.ok(first!.next_cursor);
    assert.equal(first!.next_before, 8_759_336);

    const q = sqlFetch([eventRow(8_759_330, 1)]);
    await loadChainEventsColdTier(TOKEN, {
      limit: 2,
      cursor: first!.next_cursor,
    });
    // Resume strictly past the cursor's row rather than repeating it.
    assert.match(q[0]!, /block_number < 8759336 OR event_index < 4/);
  });

  test("a block lookup needs no window and stays exact", async () => {
    // Single-block reads are already cheap (1.55 MB measured); windowing them
    // would be pointless and could exclude the block itself.
    const q = sqlFetch([eventRow(8_000_000, 0)]);
    const page = await loadChainEventsColdTier(TOKEN, {
      limit: 50,
      block: 8_000_000,
      extrinsic: 3,
    });
    assert.match(q[0]!, /block_number = 8000000/);
    assert.match(q[0]!, /extrinsic_index = 3/);
    assert.doesNotMatch(q[0]!, /block_number >=/);
    // Nothing below a single block to walk to.
    assert.equal(page!.next_before, null);
  });

  test("composes the pallet and method filters", async () => {
    const q = sqlFetch([eventRow(8_759_336, 1)]);
    await loadChainEventsColdTier(TOKEN, {
      limit: 5,
      pallet: "SubtensorModule",
      method: "PrometheusServed",
    });
    assert.match(q[0]!, /pallet = 'SubtensorModule'/);
    assert.match(q[0]!, /method = 'PrometheusServed'/);
  });

  test.each([
    ["pallet", { pallet: "Bal' OR '1'='1" }],
    ["method", { method: "x; DROP" }],
    ["block", { block: "not-a-block" }],
    ["extrinsic", { extrinsic: "abc" }],
    ["before", { before: "abc" }],
  ] as [string, Record<string, unknown>][])(
    "declines an unusable %s rather than dropping the filter",
    async (_label, extra) => {
      // Dropping a malformed filter would WIDEN the feed to everything and
      // return a 200 that looks filtered.
      const q = sqlFetch([]);
      assert.equal(
        await loadChainEventsColdTier(TOKEN, { limit: 5, ...extra }),
        null,
      );
      assert.equal(q.length, 0, "must not issue a query at all");
    },
  );

  test("declines an unusable limit", async () => {
    const q = sqlFetch([]);
    for (const limit of [0, -1, Number.NaN]) {
      assert.equal(await loadChainEventsColdTier(TOKEN, { limit }), null);
    }
    assert.equal(q.length, 0);
  });

  test("declines when the lakehouse cannot answer", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    assert.equal(await loadChainEventsColdTier(TOKEN, { limit: 5 }), null);
  });
});

describe("loadChainEventsStatsColdTier", () => {
  const GROUP = { pallet: "Balances", method: "Transfer", count: 976_676 };

  test("bounds the window on block_number and caps the group list", async () => {
    // The deleted Postgres version carried a second observed_at bound and a
    // separate head lookup purely so Timescale could exclude chunks -- without
    // it the aggregate scanned ~723M rows. block_number IS the lakehouse's
    // pruning key, so the block bound alone does that work.
    const q = sqlFetch([GROUP]);
    const stats = await loadChainEventsStatsColdTier(TOKEN);
    assert.ok(stats);
    assert.equal(stats.window_blocks, CHAIN_EVENTS_STATS_BLOCKS_DEFAULT);
    assert.equal(stats.groups, 1);
    assert.match(
      q[0]!,
      new RegExp(
        `block_number > ${DEFAULT_BLOCKS_SEAM - CHAIN_EVENTS_STATS_BLOCKS_DEFAULT}`,
      ),
    );
    assert.match(q[0]!, /GROUP BY pallet, method/);
    assert.match(q[0]!, /LIMIT 100/);
    assert.doesNotMatch(q[0]!, /observed_at/);
  });

  test("orders by count then the GROUP BY keys so ties are stable", async () => {
    // count is non-unique: ordering on it alone lets equal-count groups
    // reshuffle between requests and flip which ones survive the LIMIT.
    const q = sqlFetch([GROUP]);
    await loadChainEventsStatsColdTier(TOKEN);
    assert.match(q[0]!, /ORDER BY count DESC, pallet ASC, method ASC/);
  });

  test("clamps ?blocks= to the 1-5000 bound", async () => {
    for (const [asked, expected] of [
      [500, 500],
      [99_999, CHAIN_EVENTS_STATS_BLOCKS_MAX],
      [0, CHAIN_EVENTS_STATS_BLOCKS_DEFAULT],
      [null, CHAIN_EVENTS_STATS_BLOCKS_DEFAULT],
    ] as [number | null, number][]) {
      sqlFetch([GROUP]);
      const stats = await loadChainEventsStatsColdTier(TOKEN, asked);
      assert.equal(stats!.window_blocks, expected, `blocks=${asked}`);
    }
  });

  test("declines an unusable ?blocks= rather than silently defaulting", async () => {
    // Defaulting a malformed value would answer a DIFFERENT question than the
    // caller asked and look successful doing it.
    const q = sqlFetch([]);
    assert.equal(
      await loadChainEventsStatsColdTier(TOKEN, "not-a-number"),
      null,
    );
    assert.equal(q.length, 0, "must not issue a query at all");
  });

  test("declines when the lakehouse cannot answer", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    assert.equal(await loadChainEventsStatsColdTier(TOKEN), null);
  });
});

describe("loadSubnetLeaseHistoryColdTier", () => {
  test("no lease events anywhere means every subnet's history is a real empty", async () => {
    // Verified against the complete 895M-row stream: SubnetLeaseCreated and
    // SubnetLeaseTerminated have zero rows in all of chain history. The route
    // currently answers `tier_unavailable`, which claims the data is missing
    // and bars the response from the edge cache -- for something that will
    // never change until leasing is used.
    const q = sqlFetch([]);
    const out = await loadSubnetLeaseHistoryColdTier(TOKEN, 1);
    assert.deepEqual(out, { rows: [] });
    assert.match(
      q[0]!,
      /method IN \('SubnetLeaseCreated', 'SubnetLeaseTerminated'\)/,
    );
    assert.match(q[0]!, /LIMIT 1/);
  });

  test("DECLINES once lease events exist, rather than guessing the subnet", async () => {
    // netuid lives in the positional args JSON and R2 SQL has no JSON
    // extraction, so a per-subnet filter is not expressible. The day leasing
    // starts this route needs a real decoder; declining makes that visible
    // instead of silently attributing every lease to one subnet.
    sqlFetch([{ block_number: 8_000_000 }]);
    assert.equal(await loadSubnetLeaseHistoryColdTier(TOKEN, 1), null);
  });

  test("declines an unusable netuid", async () => {
    const q = sqlFetch([]);
    assert.equal(
      await loadSubnetLeaseHistoryColdTier(TOKEN, "abc" as never),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("declines when the lakehouse cannot answer", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    assert.equal(await loadSubnetLeaseHistoryColdTier(TOKEN, 1), null);
  });
});

// #8700: THE CEILING IS READ, NOT ASSUMED.
//
// Both readers used to anchor page one on `blocksSeamFloor` -- a CONSTANT. The
// decoder appends past it every hour, so in production the feed's newest event
// stayed pinned at block 8,759,336 while the lakehouse held 11,746 blocks more,
// and `/chain-events/stats`, published as "the most recent N blocks",
// aggregated a window receding further into history every day.
//
// Every test here asserts the POSITIVE: the query was issued, and the ceiling
// in it is the watermark's. An "it does not use the constant" assertion alone
// passes just as well on a reader that returns nothing at all.
describe("the page-one ceiling tracks the published decode watermark", () => {
  const AHEAD = DEFAULT_BLOCKS_SEAM + 11_746;

  /** An env whose archive publishes `decoded_through` for one network. */
  function watermarkEnv(
    body: unknown,
    network: "mainnet" | "testnet" = "mainnet",
  ) {
    resetDecodeWatermarkCache();
    return {
      ...TOKEN,
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          if (key !== decodeWatermarkKey(network) || body === undefined) {
            return null;
          }
          return {
            async text() {
              return JSON.stringify(body);
            },
          };
        },
      },
    } as unknown as Env;
  }

  test("the feed reads down from the watermark, not the seam constant", async () => {
    const q = sqlFetch([eventRow(AHEAD, 4)]);
    const page = await loadChainEventsColdTier(
      watermarkEnv({ decoded_through: AHEAD }),
      { limit: 50 },
    );
    assert.equal(q.length, 1, "the lakehouse was never queried");
    assert.match(q[0]!, new RegExp(`block_number <= ${AHEAD}\\b`));
    assert.match(
      q[0]!,
      new RegExp(`block_number >= ${AHEAD - CHAIN_EVENTS_BLOCK_WINDOW}\\b`),
    );
    assert.equal(page?.events[0]!.block_number, AHEAD);
  });

  test("the stats window ends at the watermark", async () => {
    const q = sqlFetch([
      { pallet: "System", method: "ExtrinsicSuccess", count: 9 },
    ]);
    const stats = await loadChainEventsStatsColdTier(
      watermarkEnv({ decoded_through: AHEAD }),
      500,
    );
    assert.equal(q.length, 1, "the lakehouse was never queried");
    assert.match(q[0]!, new RegExp(`block_number > ${AHEAD - 500}\\b`));
    assert.equal(stats?.groups, 1);
  });

  // The fail-safe `resolveBlocksSeam` also makes: a watermark that is missing,
  // unreadable or BEHIND the floor cannot pull the ceiling below history the
  // lakehouse is known to hold.
  test("a missing or regressed watermark keeps mainnet's floor", async () => {
    for (const body of [undefined, { decoded_through: 1 }, { nope: true }]) {
      const q = sqlFetch([eventRow(DEFAULT_BLOCKS_SEAM, 1)]);
      const page = await loadChainEventsColdTier(watermarkEnv(body), {
        limit: 50,
      });
      assert.equal(q.length, 1, "the lakehouse was never queried");
      assert.match(
        q[0]!,
        new RegExp(`block_number <= ${DEFAULT_BLOCKS_SEAM}\\b`),
        `for ${JSON.stringify(body)}`,
      );
      assert.equal(page?.count, 1);
    }
  });

  // Off mainnet there is no floor to fall back on: ICEBERG_BLOCKS_MAX is
  // mainnet's own exodus boundary, 1.06M blocks ABOVE testnet's capture range,
  // so applying it would silently scan a window that chain has never had.
  test("testnet reads its own namespace at its own watermark", async () => {
    const q = sqlFetch([eventRow(7_700_842, 2)]);
    const page = await loadChainEventsColdTier(
      watermarkEnv({ decoded_through: 7_700_842 }, "testnet"),
      { limit: 50 },
      "testnet",
    );
    assert.equal(q.length, 1, "the lakehouse was never queried");
    assert.match(q[0]!, /FROM chain_testnet\.chain_events\b/);
    assert.match(q[0]!, /block_number <= 7700842\b/);
    assert.equal(page?.events[0]!.block_number, 7_700_842);
  });

  test("a network with no published watermark declines rather than guessing", async () => {
    for (const load of [
      () =>
        loadChainEventsColdTier(
          watermarkEnv(undefined, "testnet"),
          { limit: 50 },
          "testnet",
        ),
      () =>
        loadChainEventsStatsColdTier(
          watermarkEnv(undefined, "testnet"),
          500,
          "testnet",
        ),
    ]) {
      const q = sqlFetch([]);
      assert.equal(await load(), null);
      assert.equal(q.length, 0, "declining must not issue a query at all");
    }
  });

  // A cursor or `before` carries its own ceiling, so paging never needs the
  // watermark -- and must keep working on a network that has none.
  test("a cursor page needs no watermark at all", async () => {
    const q = sqlFetch([eventRow(7_700_500, 1)]);
    const page = await loadChainEventsColdTier(
      watermarkEnv(undefined, "testnet"),
      { limit: 50, before: 7_700_501 },
      "testnet",
    );
    assert.equal(q.length, 1, "the lakehouse was never queried");
    assert.match(q[0]!, /block_number <= 7700500\b/);
    assert.equal(page?.count, 1);
  });
});

// The feed's rows go through the SAME formatter as the D1 hot tier and
// /blocks/{n}/chain-events, so a caller cannot tell which tier answered.
//
// Serving the raw lakehouse rows was a live contract break, not a cosmetic
// one: `chain_events.args` is TEXT in Iceberg, so the published feed carried a
// JSON STRING where its own schema declares an object, and `summary` -- which
// every sibling tier computes -- was absent. Measured against production
// 2026-08-04 before the fix.
describe("the feed publishes the same event shape as its sibling tiers", () => {
  const RAW = {
    block_number: 8_759_336,
    event_index: 294,
    pallet: "System",
    method: "ExtrinsicSuccess",
    // TEXT, exactly as Iceberg hands it back.
    args: '{"dispatch_info":{"class":{"name":"Normal","values":[]}}}',
    phase: "ApplyExtrinsic",
    extrinsic_index: 21,
    observed_at: 1_785_708_540_000,
  };

  test("args is decoded, not the raw JSON text the column holds", async () => {
    sqlFetch([RAW]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 50 });
    const event = page?.events[0] as Record<string, unknown>;
    assert.ok(event, "the feed returned no event to check");
    assert.notEqual(
      typeof event.args,
      "string",
      "args must be decoded, not the raw column text",
    );
    assert.equal(
      (event.args as Record<string, unknown>).dispatch_info !== undefined,
      true,
    );
  });

  test("summary is computed, as it is on every other tier", async () => {
    sqlFetch([RAW]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 50 });
    const event = page?.events[0] as Record<string, unknown>;
    assert.ok("summary" in event, "summary must be present, not merely null");
    assert.equal(typeof event.summary, "string");
  });

  // additionalProperties:false, so an unformatted row fails this outright.
  test("a page parses against its own published schema", async () => {
    sqlFetch([RAW]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 50 });
    assert.ok(ChainEventsFeedArtifactSchema.parse(page));
  });

  // Paging reads the RAW rows, so a row the formatter cannot handle must not
  // strand the cursor -- which is why the cursor is built before formatting.
  test("the cursor survives a row the formatter cannot decode", async () => {
    sqlFetch([{ ...RAW, args: "not json" }]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 1 });
    assert.equal(page?.next_before, 8_759_336);
    assert.equal(page?.next_cursor, "1785708540000.8759336.294");
    assert.equal((page?.events[0] as Record<string, unknown>).args, null);
  });
});

// The caller-error half of the reader's `null`. It returns null for an unusable
// FILTER and for an unreachable door alike, and the two are different answers:
// one is a 400 the caller can fix, the other a degraded empty they should
// retry. Everything below reads the same guards the query builder uses, so the
// validator cannot start accepting what the builder still rejects.
describe("chainEventsQueryError names the unusable parameter", () => {
  test("a usable query is null", () => {
    assert.equal(chainEventsQueryError({ limit: 50 }), null);
    assert.equal(
      chainEventsQueryError({
        limit: 50,
        pallet: "SubtensorModule",
        method: "WeightsSet",
        block: 8_759_336,
        extrinsic: 2,
        before: 8_759_000,
      }),
      null,
    );
  });

  test("each parameter is named by its own guard", () => {
    for (const [query, expected] of [
      [{ limit: 0 }, "limit"],
      [{ limit: "many" }, "limit"],
      [{ limit: 50, pallet: "not a pallet name" }, "pallet"],
      [{ limit: 50, method: "Weights'; DROP" }, "method"],
      [{ limit: 50, block: "soon" }, "block"],
      [{ limit: 50, extrinsic: -1 }, "extrinsic"],
      [{ limit: 50, before: "yesterday" }, "before"],
    ] as [Record<string, unknown>, string][]) {
      assert.equal(
        chainEventsQueryError(query as never),
        expected,
        JSON.stringify(query),
      );
    }
  });

  // A cursor supersedes `before`, so an unusable one is inert -- rejecting it
  // would break a caller paging by cursor who still echoes their stale `before`.
  test("an unusable before is inert once a cursor supersedes it", () => {
    assert.equal(
      chainEventsQueryError({
        limit: 50,
        cursor: "1785708540000.8759336.294",
        before: "yesterday",
      } as never),
      null,
    );
  });
});

// formatEvents falls back to the RAW row when the formatter declines. It only
// declines on a non-object row, which R2 SQL will not produce -- but the feed
// must not drop a row it cannot format, because a silently shorter page is
// indistinguishable from a quieter chain.
describe("an unformattable row is passed through, never dropped", () => {
  test("a row the formatter cannot read still survives the page", async () => {
    // An object, so it is a legal catalog row, but carrying nothing the
    // formatter recognises. THIS is the case the pass-through exists for, and
    // it must still hold: the page keeps its count rather than quietly
    // shortening.
    sqlFetch([{} as Record<string, unknown>]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 50 });
    assert.equal(page?.count, 1, "the row must survive, unformatted");
    assert.equal(page?.events.length, 1);
  });

  test("a NON-OBJECT row declines the read rather than riding along", async () => {
    // The old fixture here was `null`, and its own comment said R2 SQL will not
    // produce that. It cannot ride the pass-through any more: the read
    // validates against the catalog, and `null` is not a row. Declining is not
    // the silent shortening this suite guards against -- it degrades the whole
    // answer explicitly, which the caller already handles.
    sqlFetch([null as unknown as Record<string, unknown>]);
    const page = await loadChainEventsColdTier(TOKEN, { limit: 50 });
    assert.equal(page, null, "a corrupt row declines, never half-serves");
  });
});

/**
 * The head of this feed, from Neon instead of the lakehouse.
 *
 * Measured live 2026-08-17, `/api/v1/chain-events?limit=5` -- the explorer's
 * "what is happening on chain" feed:
 *
 *   16.9s, 0 rows, x-metagraph-degraded: tier_unavailable
 *   server-timing: r2sql;dur=15030;desc="1 call"
 *
 * 15,030ms is the lakehouse query ceiling. The read was already windowed to
 * 5,000 blocks and still could not finish, so the feed served an empty list
 * with a degraded header on every request. The same rows answer in 0.030ms off
 * `chain_detail_chain_events`'s primary key, which IS this feed's sort order.
 */
describe("loadChainEventsColdTier -- the Neon head", () => {
  const hotRow = (block: number, index = 0, pallet = "SubtensorModule") => ({
    block_number: block,
    event_index: index,
    pallet,
    method: "NeuronRegistered",
    args: "{}",
    phase: "ApplyExtrinsic",
    extrinsic_index: 1,
    observed_at: 1_700_000_000_000 + block,
  });

  /** A store answering the head read with `rows`. */
  function store(rows: Record<string, unknown>[]) {
    const seen: string[] = [];
    pg.control.queries.length = 0;
    pg.control.answers = [];
    pg.control.rows = null;
    pg.control.failNext = null;
    pg.control.onQuery = ({ text }) => {
      seen.push(text);
      pg.control.rows = rows;
    };
    return { seen, env: { ...TOKEN, ...pgMockEnv() } as unknown as Env };
  }

  test("A FULL PAGE COMES FROM NEON, with no lakehouse query at all", async () => {
    const q = sqlFetch([]);
    const { seen, env } = store([hotRow(900), hotRow(899), hotRow(898)]);
    const page = await loadChainEventsColdTier(env, { limit: 3 });
    assert.ok(page);
    assert.equal(page.count, 3);
    assert.equal(q.length, 0, `expected no R2 SQL:\n${q.join("\n")}`);
    assert.equal(page.events[0]!.block_number, 900, "newest first");
    assert.match(seen[0]!, /ORDER BY block_number DESC, event_index DESC/);
  });

  test("A SHORT PAGE FALLS THROUGH -- it does not truncate the feed", async () => {
    // The hot store is contiguous from its floor to the head, so a FULL page is
    // provably the newest N; a short one means the rest lies below that floor,
    // where only the lakehouse has it. Serving the short page would silently
    // truncate the feed AND break the walk.
    const q = sqlFetch([]);
    const { env } = store([hotRow(900)]);
    await loadChainEventsColdTier(env, { limit: 5 });
    assert.ok(q.length > 0, "expected the lakehouse read");
  });

  test("THE CURSOR IS THE SAME TOKEN the lakehouse leg reads", async () => {
    // What lets the walk cross the seam: page 1 from Neon, page 2 from
    // whichever tier holds the next rows. A cursor of a different shape would
    // strand the caller at the boundary.
    const { env } = store([hotRow(900), hotRow(899)]);
    sqlFetch([]);
    const page = await loadChainEventsColdTier(env, { limit: 2 });
    assert.ok(page?.next_cursor, "a full page must paginate");
    assert.equal(page.next_before, 899);

    // Feed it back: the ceiling now comes from the cursor, not the head.
    const second = store([hotRow(898), hotRow(897)]);
    sqlFetch([]);
    const next = await loadChainEventsColdTier(second.env, {
      limit: 2,
      cursor: page.next_cursor,
    });
    assert.ok(next);
    // `$1`, not `?`: `toPositionalPlaceholders` rewrites the placeholders on
    // the way to pg, so the recorded text is the converted form.
    assert.match(second.seen[0]!, /block_number <= \$\d/);
  });

  test("A PALLET FILTER IS APPLIED IN THE QUERY, not to a cut page", async () => {
    // A filter applied after the page was already cut to `limit` would return
    // fewer than the caller asked for while more matches existed.
    const { seen, env } = store([hotRow(900, 0, "Balances")]);
    sqlFetch([]);
    await loadChainEventsColdTier(env, { limit: 1, pallet: "Balances" });
    assert.match(seen[0]!, /pallet = \$\d/);
  });

  test("A SINGLE-BLOCK LOOKUP still goes to the lakehouse", async () => {
    // `?block=` is exact and already cheap, and the hot store holds only a
    // rolling window -- answering a historical block from it would 404 a block
    // the lakehouse has.
    const q = sqlFetch([]);
    const { env } = store([hotRow(900)]);
    await loadChainEventsColdTier(env, { limit: 5, block: 900 });
    assert.ok(q.length > 0, "expected the lakehouse read");
  });

  test("ANOTHER NETWORK never reads mainnet's hot store", async () => {
    // `chain_detail_*` carries no network column.
    sqlFetch([]);
    const { seen, env } = store([hotRow(900), hotRow(899)]);
    await loadChainEventsColdTier(env, { limit: 2 }, "testnet");
    // The hot store is never touched -- that is the whole assertion. Whether
    // the lakehouse leg then answers or declines is that tier's business (with
    // no resolvable testnet head it declines), and asserting on it here would
    // pin an unrelated contract.
    assert.equal(seen.length, 0, "mainnet's hot store was asked for testnet");
  });

  test("AN UNUSABLE ARGUMENT REFUSES, and issues no query", async () => {
    // `loadChainEventsHeadHotTier` is EXPORTED, so "the one caller already
    // validated it" is a property of today's code and not of the function. A
    // bad argument must refuse rather than emit `LIMIT 0`, an unbounded read,
    // or a `pallet = ''` that quietly matches nothing.
    pg.control.queries.length = 0;
    pg.control.onQuery = () => {
      pg.control.rows = [];
    };
    const env = pgMockEnv();
    for (const [label, opts] of [
      ["zero limit", { limit: 0, ceiling: null }],
      ["negative limit", { limit: -1, ceiling: null }],
      ["NaN limit", { limit: Number.NaN, ceiling: null }],
      ["unusable ceiling", { limit: 5, ceiling: Number.NaN }],
      ["empty pallet", { limit: 5, ceiling: null, pallet: "" }],
      ["non-string method", { limit: 5, ceiling: null, method: 7 as never }],
    ] as [string, Parameters<typeof loadChainEventsHeadHotTier>[1]][]) {
      assert.equal(
        await loadChainEventsHeadHotTier(env, opts),
        null,
        `${label} must be refused`,
      );
    }
    assert.equal(
      pg.control.queries.length,
      0,
      "an unusable argument reached the store",
    );
  });

  test("AN UNREADABLE STORE falls through rather than declining", async () => {
    const q = sqlFetch([]);
    pg.control.queries.length = 0;
    pg.control.onQuery = () => {
      pg.control.failNext = new Error("store down");
    };
    const page = await loadChainEventsColdTier(
      { ...TOKEN, ...pgMockEnv() } as unknown as Env,
      { limit: 2 },
    );
    assert.ok(page, "the lakehouse still answers");
    assert.ok(q.length > 0);
  });
});
