// Same properties as the sibling cold tiers: no silent widening, parity via
// the shared formatters, data-api's exact cursor token and order — plus the
// one equivalence specific to this module: the single OR disjunction must
// stand in for data-api's two-scan hotkey/coldkey read.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadAccountEventsColdTier,
  loadBlockEventsColdTier,
} from "../src/events-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

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
