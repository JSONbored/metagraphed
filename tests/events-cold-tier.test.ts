// Same properties as the sibling cold tiers: no silent widening, parity via
// the shared formatters, data-api's exact cursor token and order — plus the
// one equivalence specific to this module: the single OR disjunction must
// stand in for data-api's two-scan hotkey/coldkey read.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadAccountEventsColdTier,
  loadBlockChainEventsColdTier,
  loadBlockEventsColdTier,
  loadSubnetEventsColdTier,
} from "../src/events-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
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
    amount_tao: "1000000",
    alpha_amount: null,
    observed_at: 1_700_000_000_000 + block,
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

    sqlFetch([{ ...eventRow(3), block_number: "bad" }]);
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
    // Iceberg stores args as a JSON string exactly as D1 stores it as TEXT, so
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
