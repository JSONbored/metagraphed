// Same properties as the sibling cold tiers: no silent widening, parity via
// the shared formatters, data-api's exact cursor token and order — plus the
// one equivalence specific to this module: the single OR disjunction must
// stand in for data-api's two-scan hotkey/coldkey read.
import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { loadAccountEventsHotTier } from "../src/chain-detail-hot-tier.ts";

// The Neon head leg reads `chain_detail_account_events` through
// src/read-store.ts, which builds `new Client(...)` itself -- so the module is
// the seam. See tests/helpers/pg-mock.ts for why the controller is built inside
// vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import {
  loadAccountEventsColdTier,
  loadBlockChainEventsColdTier,
  loadBlockEventsColdTier,
  loadSubnetEventsColdTier,
} from "../src/events-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { encodeCursor } from "../src/cursor.ts";
import { accountSummaryArchive } from "./helpers/cold-tier-env.ts";
import { visibleInWindow } from "./helpers/scan-window.ts";
import { OFFSET_EMULATION_CAP } from "../src/r2-sql-blocks.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function eventRow(block: number, index = 0) {
  return {
    block_number: block,
    event_index: index,
    extrinsic_index: 1,
    event_kind: "StakeAdded",
    hotkey: ADDR,
    coldkey: null,
    netuid: 7,
    uid: 3,
    // A NUMBER, not a string. R2 SQL answers JSON, so a `double` arrives as a
    // JS number -- production serves 4.99 and 213744.676471047 alike. The
    // string here was a Postgres-era shape (node-postgres leaves int8 a
    // string); the lakehouse read now validates against the catalog and
    // refuses it.
    amount_tao: 1_000_000,
    alpha_amount: null,
    observed_at: 1_700_000_000_000 + block,
  };
}

/**
 * WINDOW-AWARE since #11131 -- see tests/helpers/scan-window.ts for why a
 * replaying double reports a windowed reader as a paging bug.
 */
function sqlFetch(...responses: unknown[][]) {
  const queries: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const sql = String(JSON.parse(String(init.body)).query);
    queries.push(sql);
    const rows = visibleInWindow(
      sql,
      responses[Math.min(call, responses.length - 1)] ?? [],
    );
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

// The fixtures below are dated by `1_700_000_000_000 + block`, and the scan
// window (#11131) is two days wide off the wall clock -- so with a real clock
// every read here would widen through the whole table before finding them.
// Pinning Date to the fixtures' own era makes the FIRST window the one that
// answers, which is the production shape for an account with recent activity.
// Only Date is faked; timers are left alone.
beforeAll(() => {
  vi.useFakeTimers({ now: 1_700_000_100_000, toFake: ["Date"] });
});
afterAll(() => {
  vi.useRealTimers();
});

/**
 * The floor the account-summary projection already knows, applied to the feed
 * route the summary's own 503 message names as the fallback.
 *
 * Measured 2026-08-16 on 5EEmaGFE...5oM3qDSC: `/events?limit=5` took 26.7s
 * against 8.1s for the card, because this read consulted no projection at all
 * and walked to the beginning of time.
 */
describe("loadAccountEventsColdTier -- the projection floor", () => {
  const FLOOR = Date.parse("2026-08-15T00:00:00.000Z");
  const FIRST = 1_786_629_372_000;

  const archive = (entry: unknown) =>
    accountSummaryArchive({ accounts: { [ADDR]: entry } });

  test("a PRESENT account floors at its earliest folded event", async () => {
    const q = sqlFetch([eventRow(10, 0)]);
    await loadAccountEventsColdTier(
      {
        ...TOKEN,
        ...archive([
          {
            kind: "NeuronRegistered",
            netuid: 105,
            count: 1,
            fb: 8_836_052,
            lb: 8_836_052,
            fo: FIRST,
            lo: FIRST,
          },
        ]),
      } as never,
      ADDR,
      { limit: 5 },
    );
    assert.ok(q.length > 0, "premise: a read was issued");
    assert.ok(
      q.every((sql) => sql.includes(`observed_at >= ${FIRST}`)),
      `unfloored read: ${q.find((sql) => !sql.includes(`observed_at >= ${FIRST}`))?.slice(0, 120)}`,
    );
  });

  test("an ABSENT account floors at the generation's edge", async () => {
    // The producer writes every shard, so absence PROVES there is nothing at or
    // before `through` -- the strongest floor available.
    const q = sqlFetch([eventRow(10, 0)]);
    await loadAccountEventsColdTier(
      { ...TOKEN, ...archive(null) } as never,
      ADDR,
      { limit: 5 },
    );
    assert.ok(q.length > 0, "premise: a read was issued");
    assert.ok(
      q.every((sql) => sql.includes(`observed_at >= ${FLOOR}`)),
      "an absent account must bound to the generation edge",
    );
  });

  test("NO projection means the walk is unchanged", async () => {
    // The floor is an optimization over a correct read, never a precondition
    // for one: with no artifact bound, this must behave exactly as before.
    const q = sqlFetch([eventRow(10, 0)]);
    const data = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 5,
    });
    assert.ok(data);
    assert.ok(q.every((sql) => !sql.includes("observed_at >= 1786")));
  });

  test("a NON-DEFAULT network reads no projection at all", async () => {
    // The projection describes mainnet, so flooring a testnet feed with it
    // would bound a feed against another chain's history.
    let asked = 0;
    const bucket = {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          asked += 1;
          return null;
        },
      },
    };
    const q = sqlFetch([eventRow(10, 0)]);
    await loadAccountEventsColdTier(
      { ...TOKEN, ...bucket } as never,
      ADDR,
      { limit: 5 },
      "testnet",
    );
    assert.equal(asked, 0, "no projection read for another chain");
    assert.ok(q.length > 0);
  });
});

describe("loadAccountEventsColdTier", () => {
  test("reads both key sides with one disjunction, newest first", async () => {
    const q = sqlFetch([eventRow(10, 1), eventRow(10, 0)]);
    const data = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 2,
    });
    assert.equal(data!.events.length, 2);
    assert.match(
      q[0]!,
      new RegExp(`\\(hotkey = '${ADDR}' OR coldkey = '${ADDR}'\\)`),
      "one OR stands in for data-api's two-scan merge — same row set",
    );
    assert.match(
      q[0]!,
      /ORDER BY observed_at DESC, block_number DESC, event_index DESC/,
    );
  });

  test("BOUNDS ON observed_at -- the column that actually prunes", async () => {
    // THE PERFORMANCE PROPERTY, and it is invisible in the response: the rows
    // are identical either way. This shipped in #10190 bounded on
    // `block_number`, which was the wrong column. Measured against production
    // 2026-08-14, the same 50-row page for one busy account:
    //
    //   no bound                          1,933.6 MB   48 files
    //   block_number >= head - 250,000      957.7 MB   37 files
    //   observed_at  >= now - 2 days           2.9 MB  18 files
    //
    // The writer orders by observed_at, so file statistics are tight on it and
    // loose on block height -- 100x for the identical rows over the same span.
    const q = sqlFetch([eventRow(10, 1), eventRow(10, 0)]);
    await loadAccountEventsColdTier(TOKEN as never, ADDR, { limit: 2 });
    assert.match(q[0]!, /observed_at >= \d+/);
    assert.doesNotMatch(
      q[0]!,
      /block_number >= \d+/,
      "a bound on block_number costs ~100x and looks identical in review",
    );
  });

  test("THE FIRST SLICE HAS NO CEILING, so a row above the watermark is not hidden", async () => {
    // The head is the DECODE WATERMARK, and a row can land in the lakehouse
    // before the watermark advances past it. Clamping the newest slice to
    // `<= head` would drop exactly the rows a newest-first feed exists to show,
    // and it would do it silently -- the page would look full and simply be
    // missing its top. The floor is what prunes; the ceiling buys nothing here.
    const q = sqlFetch([eventRow(8_759_000, 1), eventRow(8_759_000, 0)]);
    await loadAccountEventsColdTier(TOKEN as never, ADDR, { limit: 2 });
    assert.doesNotMatch(
      q[0]!,
      /block_number <= /,
      `the newest slice must not be capped at the watermark: ${q[0]}`,
    );
  });

  test("widens the window when a page does not fill, and keeps order", async () => {
    // A sparse account: nothing in the first window, one row in the second.
    // The page must still come back FULL-shaped rather than short -- the whole
    // reason this loops internally instead of handing back a `next_before`.
    // Nothing in the first two-day window; one row a month back.
    const q = sqlFetch([eventRow(-30 * 86_400_000)]);
    const data = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 1,
    });
    assert.equal(data!.events.length, 1);
    assert.ok(q.length >= 2, `expected a second window, issued ${q.length}`);
    // Each window sits strictly below its predecessor, so concatenation is
    // globally ordered and no merge step is needed. The second slice is the
    // first to carry a ceiling, and it must sit below the first slice's floor.
    const floor = (sql: string) => Number(/observed_at >= (\d+)/.exec(sql)![1]);
    const ceil = (sql: string) => Number(/observed_at <= (\d+)/.exec(sql)![1]);
    assert.ok(
      ceil(q[1]!) < floor(q[0]!),
      "the second window must read strictly below the first, so slices are disjoint",
    );
  });

  test("a failed slice fails the read rather than returning a short page", async () => {
    // A partial answer here would be short for a reason the caller cannot see,
    // which is the silently-truncated result this family declines to serve.
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { rows: [] } }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 500,
        text: async () => "boom",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const data = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 5,
    });
    assert.equal(data, null);
  });

  test("applies kind/netuid/range filters as validated literals", async () => {
    const q = sqlFetch([eventRow(5)]);
    await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 5,
      kind: "StakeAdded",
      netuid: 7,
      blockStart: 100,
      blockEnd: 900,
      cursor: "1700000000950.950.2",
    });
    const s = q[0]!;
    assert.match(s, /event_kind = 'StakeAdded'/);
    assert.match(s, /netuid = 7/);
    assert.match(s, /block_number >= 100/);
    assert.match(s, /block_number <= 900/);
    assert.match(
      s,
      /\(observed_at, block_number, event_index\) < \(1700000000950, 950, 2\)/,
      "data-api's exact 3-part tuple seek",
    );
  });

  test("declines an unusable address instead of scanning every account", async () => {
    const q = sqlFetch([eventRow(1)]);
    assert.equal(
      await loadAccountEventsColdTier(TOKEN as never, "not-an-address", {
        limit: 5,
      }),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("declines an unsafe kind or numeric filter rather than dropping it", async () => {
    for (const bad of [
      { kind: "Stake; DROP" },
      { netuid: "abc" },
      { blockStart: -1 },
    ]) {
      const q = sqlFetch([eventRow(1)]);
      assert.equal(
        await loadAccountEventsColdTier(TOKEN as never, ADDR, {
          limit: 5,
          ...bad,
        } as never),
        null,
        JSON.stringify(bad),
      );
      assert.equal(q.length, 0);
    }
  });

  test("a malformed cursor token means page 1 — data-api's exact behavior", async () => {
    const q = sqlFetch([eventRow(9)]);
    const data = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 5,
      cursor: "junk",
    });
    assert.ok(data, "page 1, not a decline");
    assert.ok(!/junk/.test(q[0]!));
  });

  test("a cursor page ignores offset; a full page emits data-api's token", async () => {
    const q = sqlFetch([eventRow(9), eventRow(8)]);
    const paged = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 2,
      offset: 5,
      cursor: "1700000000009.9.0",
    });
    assert.match(q[0]!, /LIMIT 2/, "no over-fetch on a cursor page");
    assert.equal(paged!.next_cursor, "1700000000008.8.0");
  });

  test("offset is emulated by over-fetch and slice, and refused when deep", async () => {
    const q = sqlFetch([eventRow(9), eventRow(8), eventRow(7)]);
    const data = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 1,
      offset: 2,
    });
    assert.match(q[0]!, /LIMIT 3/);
    assert.equal(data!.events[0]!.block_number, 7);

    const q2 = sqlFetch([]);
    assert.equal(
      await loadAccountEventsColdTier(TOKEN as never, ADDR, {
        limit: 5,
        offset: 100_000,
      }),
      null,
    );
    assert.equal(q2.length, 0);
  });

  test("an invalid limit declines; a failed query yields null", async () => {
    sqlFetch([]);
    assert.equal(
      await loadAccountEventsColdTier(TOKEN as never, ADDR, {
        limit: 0,
      }),
      null,
    );
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadAccountEventsColdTier(TOKEN as never, ADDR, { limit: 5 }),
      null,
    );
  });

  test("a short page carries no cursor; an unusable last row emits none", async () => {
    sqlFetch([eventRow(3)]);
    const short = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 5,
    });
    assert.equal(short!.next_cursor ?? null, null);

    // `null`, not "bad": block_number is a `long` in the catalog and the read
    // validates against it, so a string is a row R2 SQL cannot emit. Null is
    // legal AND unusable, which is what "emits no cursor" is about.
    sqlFetch([{ ...eventRow(3), block_number: null }]);
    const odd = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 1,
    });
    assert.equal(odd!.next_cursor ?? null, null);
  });
});

describe("loadBlockEventsColdTier", () => {
  test("a numeric ref reads that block in event_index ASC order", async () => {
    const q = sqlFetch([eventRow(4200, 0), eventRow(4200, 1)]);
    const data = await loadBlockEventsColdTier(TOKEN as never, "4200", {
      limit: 10,
    });
    assert.equal(data!.events.length, 2);
    assert.equal(data!.block_number, 4200);
    assert.match(q[0]!, /block_number = 4200/);
    assert.match(
      q[0]!,
      /ORDER BY event_index ASC/,
      "a block is read top-to-bottom, unlike the newest-first feeds",
    );
  });

  test("a hash ref resolves to a height first", async () => {
    const q = sqlFetch([{ block_number: 77 }], [eventRow(77)]);
    const data = await loadBlockEventsColdTier(TOKEN as never, "0xbeef", {
      limit: 10,
    });
    assert.match(q[0]!, /FROM chain\.blocks WHERE block_hash = '0xbeef'/);
    assert.match(q[1]!, /block_number = 77/);
    assert.equal(data!.events.length, 1);
  });

  test("offset is emulated; an unknown hash or bad ref declines", async () => {
    const q = sqlFetch([
      eventRow(4200, 0),
      eventRow(4200, 1),
      eventRow(4200, 2),
    ]);
    const data = await loadBlockEventsColdTier(TOKEN as never, "4200", {
      limit: 1,
      offset: 2,
    });
    assert.match(q[0]!, /LIMIT 3/);
    assert.equal(data!.events[0]!.event_index, 2);

    sqlFetch([]); // hash resolves to nothing
    assert.equal(
      await loadBlockEventsColdTier(TOKEN as never, "0xabcd", { limit: 5 }),
      null,
    );
    const q3 = sqlFetch([]);
    assert.equal(
      await loadBlockEventsColdTier(TOKEN as never, "'; DROP --", { limit: 5 }),
      null,
    );
    assert.equal(q3.length, 0);
  });

  test("a failing hash resolve declines rather than guessing a height", async () => {
    globalThis.fetch = (async () => {
      throw new Error("resolve down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadBlockEventsColdTier(TOKEN as never, "0xdead", { limit: 5 }),
      null,
    );
  });

  test("invalid paging declines; a failed query yields null", async () => {
    sqlFetch([]);
    assert.equal(
      await loadBlockEventsColdTier(TOKEN as never, "42", { limit: 0 }),
      null,
    );
    assert.equal(
      await loadBlockEventsColdTier(TOKEN as never, "42", {
        limit: 5,
        offset: 100_000,
      }),
      null,
    );
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadBlockEventsColdTier(TOKEN as never, "42", { limit: 5 }),
      null,
    );
  });
});

describe("loadSubnetEventsColdTier", () => {
  test("scopes to one subnet, newest first, with data-api's ordering", async () => {
    const q = sqlFetch([eventRow(10, 1), eventRow(10, 0)]);
    const out = await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
      limit: 2,
    });
    assert.ok(out);
    assert.equal(out.netuid, 7);
    assert.equal(out.event_count, 2);
    assert.equal(q.length, 1);
    assert.match(q[0]!, /FROM chain\.account_events/);
    assert.match(q[0]!, /netuid = 7/);
    assert.match(
      q[0]!,
      /ORDER BY observed_at DESC, block_number DESC, event_index DESC/,
    );
    // The netuid is inlined as a bounded integer, never as caller text.
    assert.doesNotMatch(q[0]!, /netuid = '/);
  });

  test("declines a non-numeric netuid rather than scanning every subnet", async () => {
    // The failure this prevents is an UNFILTERED read of a 441M-row table.
    const q = sqlFetch([]);
    assert.equal(
      await loadSubnetEventsColdTier(
        TOKEN as unknown as Env,
        "7; DROP" as never,
        {
          limit: 5,
        },
      ),
      null,
    );
    assert.equal(q.length, 0, "must not issue a query at all");
  });

  test("composes the kind and block-range filters", async () => {
    const q = sqlFetch([eventRow(20)]);
    await loadSubnetEventsColdTier(TOKEN as unknown as Env, 1, {
      limit: 5,
      kind: "StakeAdded",
      blockStart: 8_700_000,
      blockEnd: 8_759_336,
    });
    assert.match(q[0]!, /event_kind = 'StakeAdded'/);
    assert.match(q[0]!, /block_number >= 8700000/);
    assert.match(q[0]!, /block_number <= 8759336/);
  });

  test("declines an unusable kind instead of widening to every kind", async () => {
    const q = sqlFetch([]);
    assert.equal(
      await loadSubnetEventsColdTier(TOKEN as unknown as Env, 1, {
        limit: 5,
        kind: "Stake' OR '1'='1",
      }),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("emits the 3-part cursor token and seeks with it", async () => {
    const rows = [eventRow(10, 2), eventRow(10, 1)];
    const q = sqlFetch(rows);
    const first = await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
      limit: 2,
    });
    assert.ok(first!.next_cursor, "a full page must carry a cursor");

    const q2 = sqlFetch([eventRow(9)]);
    await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
      limit: 2,
      cursor: first!.next_cursor,
    });
    // The same tuple seek the account feed uses, so tokens are interchangeable.
    assert.match(
      q2[0]!,
      /\(observed_at, block_number, event_index\) < \(\d+, \d+, \d+\)/,
    );
    void q;
  });

  test("a short page carries no cursor", async () => {
    sqlFetch([eventRow(10)]);
    const out = await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
      limit: 5,
    });
    assert.equal(out!.next_cursor, null);
  });

  test("a cursor page ignores offset, mirroring data-api", async () => {
    const rows = [eventRow(10, 2), eventRow(10, 1)];
    sqlFetch(rows);
    const first = await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
      limit: 2,
    });
    const q = sqlFetch(rows);
    await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
      limit: 2,
      offset: 5,
      cursor: first!.next_cursor,
    });
    assert.match(q[0]!, /LIMIT 2/, "offset must not inflate a cursor page");
  });

  test("declines past the offset-emulation cap", async () => {
    const q = sqlFetch([]);
    assert.equal(
      await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
        limit: 5,
        offset: OFFSET_EMULATION_CAP + 1,
      }),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("declines an unusable limit rather than issuing an unbounded read", async () => {
    const q = sqlFetch([]);
    for (const limit of [0, -1, Number.NaN]) {
      assert.equal(
        await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, { limit }),
        null,
        `limit ${limit} must decline`,
      );
    }
    assert.equal(q.length, 0, "must not issue a query at all");
  });

  test("declines an unusable block bound instead of dropping the filter", async () => {
    // Dropping a malformed bound would silently WIDEN the scan to the whole
    // subnet -- the caller asked for a window and would get everything.
    const q = sqlFetch([]);
    assert.equal(
      await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
        limit: 5,
        blockStart: "not-a-block",
      }),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("emulates offset by over-fetching then slicing", async () => {
    const rows = [eventRow(12), eventRow(11), eventRow(10)];
    const q = sqlFetch(rows);
    const out = await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, {
      limit: 2,
      offset: 1,
    });
    // limit + offset is fetched, then the offset rows are dropped locally --
    // R2 SQL has no OFFSET.
    assert.match(q[0]!, /LIMIT 3/);
    assert.equal(out!.event_count, 2);
    assert.equal(out!.offset, 1);
    assert.equal(out!.events[0].block_number, 11);
  });

  test("declines when the lakehouse cannot answer", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    assert.equal(
      await loadSubnetEventsColdTier(TOKEN as unknown as Env, 7, { limit: 5 }),
      null,
    );
  });
});

// #9260: the raw every-event stream per block. This route answered `events: []`
// for all ~8.76M blocks at or below the decode seam because it had a hot tier
// and no cold one -- an empty 200 a caller cannot tell from a block that
// genuinely emitted nothing, and which the block header's own `event_count`
// directly contradicted.
describe("loadBlockChainEventsColdTier", () => {
  function chainEventRow(index = 0, args: unknown = null) {
    return {
      block_number: 8_500_000,
      event_index: index,
      pallet: "Balances",
      method: "Transfer",
      args,
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: 1_785_000_000_000 + index,
    };
  }

  test("reads chain.chain_events for the block in event_index ASC order", async () => {
    const q = sqlFetch([chainEventRow(0), chainEventRow(1)]);
    const data = await loadBlockChainEventsColdTier(TOKEN as never, "8500000");
    assert.equal(data!.count, 2);
    assert.equal(data!.block_number, 8_500_000);
    assert.match(q[0]!, /FROM chain\.chain_events/);
    assert.match(q[0]!, /WHERE block_number = 8500000/);
    assert.match(
      q[0]!,
      /ORDER BY event_index ASC/,
      "a block is read top-to-bottom, the order the hot tier also uses",
    );
  });

  test("issues no LIMIT — a block is a bounded unit, not a page", async () => {
    // A cap chosen "for safety" would silently truncate the one block that
    // exceeded it into a shorter feed that still looked complete.
    const q = sqlFetch([chainEventRow()]);
    await loadBlockChainEventsColdTier(TOKEN as never, "8500000");
    assert.doesNotMatch(q[0]!, /LIMIT/);
  });

  test("decodes the opaque JSON args through the SAME formatter the hot tier feeds", async () => {
    // Iceberg stores args as a JSON string exactly as D1 stored it as TEXT, so
    // one decoder covers both tiers -- a caller cannot tell which answered.
    const q = sqlFetch([
      chainEventRow(0, JSON.stringify({ amount: 30681 })),
      chainEventRow(1, "{not json"),
    ]);
    const data = await loadBlockChainEventsColdTier(TOKEN as never, "8500000");
    assert.match(q[0]!, /block_number, event_index, pallet, method, args/);
    assert.ok(
      Object.hasOwn(data!.events[0]!.args as Record<string, unknown>, "amount"),
    );
    assert.equal(data!.events[0]!.method, "Transfer");
    // One undecodable event degrades its own args, never the block's feed.
    assert.equal(data!.events[1]!.args, null);
    assert.equal(data!.count, 2);
  });

  test("a hash ref resolves to a height first, reusing the block resolver", async () => {
    const q = sqlFetch([{ block_number: 77 }], [chainEventRow(0)]);
    const data = await loadBlockChainEventsColdTier(TOKEN as never, "0xbeef");
    assert.match(q[0]!, /FROM chain\.blocks WHERE block_hash = '0xbeef'/);
    assert.match(q[1]!, /FROM chain\.chain_events WHERE block_number = 77/);
    assert.equal(data!.block_number, 77);
  });

  test("an unusable ref declines without issuing a query at all", async () => {
    const q = sqlFetch([]);
    assert.equal(
      await loadBlockChainEventsColdTier(TOKEN as never, "'; DROP --"),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("declines when the lakehouse cannot answer, never an empty payload", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
      }) as unknown as Response) as unknown as typeof fetch;
    assert.equal(
      await loadBlockChainEventsColdTier(TOKEN as never, "8500000"),
      null,
      "a failed read must decline so the caller can decline too",
    );
  });

  test("a real empty answer is a measurement, not a decline", async () => {
    // The distinction the whole issue turns on: the engine answered and the
    // answer was zero rows. That IS a block without chain events.
    sqlFetch([]);
    const data = await loadBlockChainEventsColdTier(TOKEN as never, "8500000");
    assert.deepEqual(data, { block_number: 8_500_000, count: 0, events: [] });
  });
});

/**
 * `/events` served from the projection instead of the walk.
 *
 * metagraphed-infra#575 publishes each account's newest N events as COMPLETE
 * rows, and generation 20260816T173020Z is the first to carry them
 * (`recent_limit: 10`, 814,072 accounts). `readRecent` had exactly one
 * consumer -- the summary card -- so a request for the newest five events
 * walked the lakehouse while the newest ten sat in an object the same page load
 * had already fetched.
 *
 * Measured 2026-08-16: `/events?limit=5` took 6.0s with its scan already
 * floored to five days, against 174ms for the card, which issues no query.
 */
// Shared by the two describes below: the projection leg and the Neon head leg
// answer the same route and must be measured against one fixture.
const THROUGH = "2026-08-14";
const FOLD_FLOOR = Date.parse("2026-08-15T00:00:00.000Z");
const FIRST_OBSERVED = 1_700_000_000_010;

/** A published row, in the producer's shape. */
const recentRow = (block: number, index = 0) => ({
  block_number: block,
  event_index: index,
  extrinsic_index: 1,
  event_kind: "NeuronRegistered",
  hotkey: ADDR,
  coldkey: null,
  netuid: 105,
  uid: 242,
  amount_tao: null,
  alpha_amount: null,
  observed_at: 1_700_000_000_000 + block,
});

/** An archive publishing `recent` for this account, as production now does. */
const withRecent = (rows: unknown[], recentLimit = 10) =>
  accountSummaryArchive({
    accounts: {
      [ADDR]: [
        {
          kind: "NeuronRegistered",
          netuid: 105,
          count: rows.length,
          fb: 10,
          lb: 90,
          fo: FIRST_OBSERVED,
          lo: FIRST_OBSERVED,
        },
      ],
    },
    recent: { [ADDR]: rows },
    pointer: { recent_limit: recentLimit, recent_from: "2026-07-16" },
    through: THROUGH,
  });

describe("loadAccountEventsColdTier -- the projection's recent map", () => {
  test("SERVES THE PAGE IN ONE QUERY, not a walk", async () => {
    const q = sqlFetch([]);
    const data = await loadAccountEventsColdTier(
      {
        ...TOKEN,
        ...withRecent([recentRow(90), recentRow(80), recentRow(70)]),
      } as never,
      ADDR,
      { limit: 3 },
    );
    assert.ok(data);
    assert.equal(data.events.length, 3);
    assert.equal(q.length, 1, `expected one head probe, got:\n${q.join("\n")}`);
    assert.match(q[0]!, new RegExp(`observed_at >= ${FOLD_FLOOR}`));
  });

  test("THE PAGE IS BYTE-IDENTICAL to the walk's", async () => {
    // The property that makes this safe to switch on. A hot page that differed
    // would also hand back a different cursor, and page 2 always goes to the
    // walk -- so a divergence here skips or repeats rows on the next page.
    const rows = [recentRow(90), recentRow(80), recentRow(70)];
    sqlFetch([]);
    const hot = await loadAccountEventsColdTier(
      { ...TOKEN, ...withRecent(rows) } as never,
      ADDR,
      { limit: 3 },
    );
    sqlFetch(rows);
    const cold = await loadAccountEventsColdTier(TOKEN as never, ADDR, {
      limit: 3,
    });
    assert.deepEqual(hot, cold);
  });

  test("THE HEAD PROBE WINS -- a post-fold event is not missed", async () => {
    // The projection describes events at or before its fold edge. Anything
    // newer is missing from it, which is why the probe is not optional.
    const fresh = recentRow(999);
    const q = sqlFetch([fresh]);
    const data = await loadAccountEventsColdTier(
      { ...TOKEN, ...withRecent([recentRow(90), recentRow(80)]) } as never,
      ADDR,
      { limit: 2 },
    );
    assert.ok(data);
    assert.equal(q.length, 1);
    assert.equal(data.events[0]!.block_number, 999, "the newest row must lead");
  });

  test("A FAILED PROBE FALLS THROUGH to the walk, never serves a partial", async () => {
    // The missing rows would be the NEWEST -- the top of the feed -- and the
    // payload carries nothing that could say they were dropped.
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) throw new Error("probe down");
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const data = await loadAccountEventsColdTier(
      { ...TOKEN, ...withRecent([recentRow(90), recentRow(80)]) } as never,
      ADDR,
      { limit: 2 },
    );
    assert.ok(data, "the walk still answers");
    assert.ok(call > 1, "it fell through rather than declining");
  });

  test("A ROW THE CATALOG REFUSES declines the route, on BOTH tiers", async () => {
    // Neither half of this merge is validated here, and that is deliberate:
    // the published half is parsed by `AccountSummaryRecentSchema` inside
    // `readRecent`, and the probe half by `r2SqlQuery`, which derives the
    // catalog schema from the table named in the SQL. A second `safeParse` in
    // the leg was the first version of this and was duplicated validation.
    //
    // The end-to-end contract is what matters: a row the catalog refuses makes
    // the probe null, the hot leg falls through, and the walk -- reading the
    // same table through the same guard -- declines too. The route answers
    // null, which the caller turns into a decline. It never serves the row.
    const q = sqlFetch([{ ...recentRow(999), block_number: "not a number" }]);
    const data = await loadAccountEventsColdTier(
      { ...TOKEN, ...withRecent([recentRow(90), recentRow(80)]) } as never,
      ADDR,
      { limit: 2 },
    );
    assert.equal(data, null, "a malformed row must never be served");
    assert.ok(
      q.length > 1,
      `expected a fall-through to the walk, got:\n${q.join("\n")}`,
    );
  });

  test("DECLINES on every narrowing the published list cannot express", async () => {
    // The list is the newest N UNFILTERED. The newest N matching a filter are
    // not a subset of it: an account whose ten newest are all one kind has none
    // of another in the list while having plenty in the chain.
    const rows = [recentRow(90), recentRow(80), recentRow(70)];
    for (const [label, extra] of [
      ["kind", { kind: "Transfer" }],
      ["netuid", { netuid: 7 }],
      ["blockStart", { blockStart: 10 }],
      ["blockEnd", { blockEnd: 99 }],
      ["offset", { offset: 1 }],
      ["cursor", { cursor: encodeCursor([1, 2, 3]) }],
    ] as [string, Record<string, unknown>][]) {
      const q = sqlFetch(rows);
      await loadAccountEventsColdTier(
        { ...TOKEN, ...withRecent(rows) } as never,
        ADDR,
        { limit: 2, ...extra },
      );
      assert.ok(q.length >= 1, `${label}: no read at all`);
      assert.ok(
        !q.every((sql) => sql.includes(`observed_at >= ${FOLD_FLOOR}`)),
        `${label} was served from the projection`,
      );
    }
  });

  test("A SHORT BUT COMPLETE LIST IS SERVED, not treated as insufficient", async () => {
    // The bug the first version of this shipped. `readRecent` returns a list
    // only when the pointer publishes at least `limit` per account AND the list
    // is complete for this account -- so two rows for an account with two
    // lifetime events IS the answer to `?limit=5`, not a short page.
    //
    // Measured 2026-08-16 on 5EEmaGFE...5oM3qDSC, whose whole history is two
    // events: a `rows.length < limit` check read that as "not enough" and
    // walked the lakehouse anyway, 13.4s. It rejected exactly the quiet
    // accounts the hot tier is cheapest for, which is most of them.
    const q = sqlFetch([]);
    const data = await loadAccountEventsColdTier(
      { ...TOKEN, ...withRecent([recentRow(90), recentRow(80)]) } as never,
      ADDR,
      { limit: 5 },
    );
    assert.ok(data);
    assert.equal(data.events.length, 2, "both published events are served");
    assert.equal(q.length, 1, `expected one head probe:\n${q.join("\n")}`);
    assert.match(q[0]!, new RegExp(`observed_at >= ${FOLD_FLOOR}`));
  });

  test("DECLINES when the POINTER publishes fewer than the limit asks", async () => {
    // The real insufficiency, and the only one the artifact can express: a
    // generation publishing ten per account cannot answer a request for twenty,
    // because the eleventh through twentieth were never written. That is a fact
    // about the producer, not about the account.
    const q = sqlFetch([]);
    await loadAccountEventsColdTier(
      {
        ...TOKEN,
        ...withRecent([recentRow(90), recentRow(80)], 2),
      } as never,
      ADDR,
      { limit: 5 },
    );
    assert.ok(q.length >= 1, "premise: a read was issued");
    assert.ok(
      q.every((sql) => !sql.includes(`observed_at >= ${FOLD_FLOOR}`)),
      `served from the projection: ${q[0]}`,
    );
    assert.ok(
      q.some((sql) => sql.includes(`observed_at >= ${FIRST_OBSERVED}`)),
      `the walk must floor at the account's own span: ${q[0]}`,
    );
  });

  test("A NON-DEFAULT NETWORK reads no projection at all", async () => {
    let asked = 0;
    const bucket = {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          asked += 1;
          return null;
        },
      },
    };
    sqlFetch([]);
    await loadAccountEventsColdTier(
      { ...TOKEN, ...bucket } as never,
      ADDR,
      { limit: 2 },
      "testnet",
    );
    assert.equal(asked, 0);
  });
});

/**
 * The head served from NEON instead of R2 SQL, when the two tiers provably meet.
 *
 * `chain_detail_account_events` holds the head of the chain in Neon -- measured
 * 2026-08-16, 931,486 rows from 2026-08-15T22:27Z to the head -- and was
 * indexed for the two questions the BLOCK routes ask and neither question the
 * ACCOUNT routes ask. Migration 0032 added the two it needed:
 *
 *   before  748.769 ms, 24,185 buffers, "Rows Removed by Filter: 932266"
 *   after     0.091 ms,      7 buffers, BitmapOr over the new indexes
 *
 * The projection covers everything at or before its fold edge; this store
 * covers everything from its own floor up. When the floor sits at or below the
 * edge they OVERLAP and the page needs no lakehouse query at all.
 */
describe("loadAccountEventsColdTier -- the Neon head", () => {
  const FOLD_FLOOR = Date.parse("2026-08-15T00:00:00.000Z");

  /** A store answering the floor probe and the per-account read. */
  function store(floorMs: number | null, rows: Record<string, unknown>[]) {
    const seen: string[] = [];
    pg.control.queries.length = 0;
    pg.control.answers = [];
    pg.control.rows = null;
    pg.control.failNext = null;
    // `onQuery` is handed the RECORDED query, not a bare string -- see
    // tests/helpers/pg-mock.ts. Reading `.text` is what lets this answer the
    // floor probe and the per-account read differently from one double.
    pg.control.onQuery = ({ text }) => {
      seen.push(text);
      pg.control.rows = text.includes("MIN(observed_at)")
        ? floorMs === null
          ? [{ floor_ms: null }]
          : [{ floor_ms: floorMs }]
        : rows;
    };
    return { seen, env: pgMockEnv() };
  }

  const hotRow = (block: number) => ({
    block_number: block,
    event_index: 0,
    extrinsic_index: 1,
    event_kind: "NeuronRegistered",
    hotkey: ADDR,
    coldkey: null,
    netuid: 105,
    uid: 242,
    // A STRING, as pg hands back a numeric -- the generated row type says
    // `amount_tao: string | null`. If the merge leaked that into the payload,
    // the same field would change type depending on which tier answered.
    amount_tao: "12.5",
    alpha_amount: null,
    observed_at: 1_700_000_000_000 + block,
  });

  test("NO LAKEHOUSE QUERY AT ALL when the tiers overlap", async () => {
    const q = sqlFetch([]);
    const { env } = store(FOLD_FLOOR - 90 * 60_000, [hotRow(999)]);
    const data = await loadAccountEventsColdTier(
      {
        ...TOKEN,
        ...env,
        ...withRecent([recentRow(90), recentRow(80)]),
      } as never,
      ADDR,
      { limit: 2 },
    );
    assert.ok(data);
    assert.equal(q.length, 0, `expected no R2 SQL, got:\n${q.join("\n")}`);
    assert.equal(data.events[0]!.block_number, 999, "the Neon row must lead");
  });

  test("A NUMERIC STRING from pg is coerced, not leaked", async () => {
    // pg returns numerics as strings; the lakehouse returns numbers. The
    // formatter normalises both, and this pins it -- a feed whose `amount_tao`
    // is a string on recent events and a number on old ones is a contract that
    // changes with age.
    sqlFetch([]);
    const { env } = store(FOLD_FLOOR - 90 * 60_000, [hotRow(999)]);
    const data = await loadAccountEventsColdTier(
      { ...TOKEN, ...env, ...withRecent([recentRow(90)]) } as never,
      ADDR,
      { limit: 1 },
    );
    assert.equal(typeof data!.events[0]!.amount_tao, "number");
    assert.equal(data!.events[0]!.amount_tao, 12.5);
  });

  test("A GAP BETWEEN THE TIERS falls back to the bounded R2 SQL probe", async () => {
    // Both edges move on their own schedules -- the chain-detail lane prunes to
    // a rolling window, the producer folds on its own cadence -- so a gap is
    // possible, and a page built across one is silently missing every event in
    // it. The floor is DERIVED from the store, never assumed.
    const q = sqlFetch([]);
    const { env } = store(FOLD_FLOOR + 60 * 60_000, [hotRow(999)]);
    await loadAccountEventsColdTier(
      {
        ...TOKEN,
        ...env,
        ...withRecent([recentRow(90), recentRow(80)]),
      } as never,
      ADDR,
      { limit: 2 },
    );
    assert.equal(q.length, 1, "expected the R2 SQL probe");
    assert.match(q[0]!, new RegExp(`observed_at >= ${FOLD_FLOOR}`));
  });

  test("A FAILING ACCOUNT READ falls back, even with a good floor", async () => {
    // The floor probe and the per-account read are two queries and either can
    // fail alone. A null page here means "not served from Neon", never "this
    // account has no events" -- so the R2 SQL probe still answers.
    const q = sqlFetch([]);
    pg.control.queries.length = 0;
    pg.control.answers = [];
    pg.control.rows = null;
    pg.control.failNext = null;
    pg.control.onQuery = ({ text }) => {
      if (text.includes("MIN(observed_at)")) {
        pg.control.rows = [{ floor_ms: FOLD_FLOOR - 90 * 60_000 }];
        return;
      }
      pg.control.failNext = new Error("store down");
    };
    const data = await loadAccountEventsColdTier(
      {
        ...TOKEN,
        ...pgMockEnv(),
        ...withRecent([recentRow(90), recentRow(80)]),
      } as never,
      ADDR,
      { limit: 2 },
    );
    assert.ok(data, "the R2 SQL probe still answers");
    assert.equal(q.length, 1, "expected the R2 SQL probe");
  });

  test("A NON-POSITIVE LIMIT reads nothing at all", async () => {
    // `loadAccountEventsHotTier` is EXPORTED, so "the one caller already
    // validated it" is a property of today's code and not of the function. A
    // zero limit must issue no query rather than emitting `LIMIT 0`.
    pg.control.queries.length = 0;
    pg.control.onQuery = null;
    for (const bad of [0, -1, Number.NaN]) {
      assert.equal(
        await loadAccountEventsHotTier(pgMockEnv(), ADDR, bad),
        null,
      );
    }
    assert.equal(pg.control.queries.length, 0, "an unusable limit queried");
  });

  test("AN UNREADABLE STORE falls back rather than declining", async () => {
    // A hot-tier failure means this leg could not be served from Neon, not that
    // the account has no events.
    const q = sqlFetch([]);
    const { env } = store(null, []);
    const data = await loadAccountEventsColdTier(
      {
        ...TOKEN,
        ...env,
        ...withRecent([recentRow(90), recentRow(80)]),
      } as never,
      ADDR,
      { limit: 2 },
    );
    assert.ok(data);
    assert.equal(q.length, 1, "expected the R2 SQL probe");
  });
});
