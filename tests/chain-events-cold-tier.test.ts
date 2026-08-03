// The all-events feed reader (#9146).
//
// The property that matters most here is PAGING COMPLETENESS. Each page reads
// one bounded block window, so a short page does NOT mean the feed is
// exhausted -- a sparse pallet/method filter can match nothing in one window
// and plenty below it. If a short page stopped emitting a continuation the
// feed would be silently truncated, which looks exactly like "no more events".
// That case gets its own tests.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_EVENTS_BLOCK_WINDOW,
  CHAIN_EVENTS_STATS_BLOCKS_DEFAULT,
  CHAIN_EVENTS_STATS_BLOCKS_MAX,
  loadChainEventsColdTier,
  loadChainEventsStatsColdTier,
} from "../src/chain-events-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";

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
