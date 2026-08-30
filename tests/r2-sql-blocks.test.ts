// Two properties matter here and the tests are built around them:
//   1. PARITY — the R2 tier must hand rows to the same formatters the Postgres
//      tier uses, so a caller cannot tell which answered.
//   2. NO SILENT WIDENING — R2 SQL has no bound parameters, so a filter this
//      tier cannot express safely must make it DECLINE, never quietly drop the
//      filter and return a broader result that looks correct.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadBlockFeedFromR2Sql,
  loadBlockFromR2Sql,
  loadBlockWithEconomicsFromR2Sql,
  OFFSET_EMULATION_CAP,
  currentOffsetCapDeclineGeneration,
  offsetBeyondEmulationCap,
  safeAuthorLiteral,
} from "../src/r2-sql-blocks.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { CHAIN_EVENTS_LIMIT_MAX } from "../src/route-limits.ts";
import { mockEnv } from "./row-type.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const AUTHOR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function row(n: number) {
  return {
    block_number: n,
    block_hash: `0xh${n}`,
    parent_hash: `0xh${n - 1}`,
    author: AUTHOR,
    extrinsic_count: 3,
    event_count: 7,
    spec_version: 240,
    observed_at: 1_700_000_000_000 + n,
  };
}

function economicsExtrinsic(overrides: Record<string, unknown> = {}) {
  return {
    block_number: 42,
    extrinsic_index: 0,
    extrinsic_hash: "0xext",
    signer: AUTHOR,
    call_module: "SubtensorModule",
    call_function: "add_stake",
    success: true,
    fee_tao: 0.125,
    tip_tao: 0.005,
    call_args: JSON.stringify([{ name: "netuid", value: 7 }]),
    observed_at: 1_700_000_000_042,
    ...overrides,
  };
}

function economicsEvent(overrides: Record<string, unknown> = {}) {
  return {
    block_number: 42,
    event_index: 0,
    extrinsic_index: 0,
    event_kind: "Transfer",
    hotkey: AUTHOR,
    coldkey: null,
    netuid: 19,
    uid: null,
    amount_tao: 2.5,
    alpha_amount: null,
    observed_at: 1_700_000_000_042,
    ...overrides,
  };
}

/** Captures the SQL actually sent, which is what the filter assertions check. */
function sqlFetch(rows: unknown[]) {
  const queries: string[] = [];
  const impl = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    // A real Response: the client reads through a byte cap now, which needs
    // `res.body` to be an actual stream. A `{ ok, status, json }` double takes
    // a path production never runs.
    return new Response(JSON.stringify({ success: true, result: { rows } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, queries };
}

/**
 * `sqlFetch` for a loader that issues MORE THAN ONE query.
 *
 * The shared helper replays one row set for every query, which cannot express
 * "the resolve returned this and the neighbour read returned that" -- and a
 * double that replays the same answer would let a two-query path pass while
 * reading the wrong result for the second. `null` in the sequence is a failed
 * query (a non-2xx), so the degradation path is reachable too.
 */
function sqlFetchSeq(responses: readonly (unknown[] | null)[]) {
  const queries: string[] = [];
  const impl = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    const rows = responses[queries.length - 1];
    if (rows === null || rows === undefined) {
      return new Response("upstream said no", { status: 500 });
    }
    return new Response(JSON.stringify({ success: true, result: { rows } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, queries };
}

function sqlFetchByQuery(answer: (query: string) => unknown[] | null): {
  impl: typeof fetch;
  queries: string[];
} {
  const queries: string[] = [];
  const impl = (async (_u: string, init: RequestInit) => {
    const query = JSON.parse(String(init.body)).query as string;
    queries.push(query);
    const rows = answer(query);
    if (rows === null) return new Response("upstream said no", { status: 500 });
    return new Response(JSON.stringify({ success: true, result: { rows } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, queries };
}

describe("safeAuthorLiteral", () => {
  test("accepts an SS58 address, refuses anything else", () => {
    assert.equal(safeAuthorLiteral(AUTHOR), AUTHOR);
    for (const bad of ["", "short", "has space", "0'; DROP--", 42, null]) {
      assert.equal(safeAuthorLiteral(bad), null, `rejected ${String(bad)}`);
    }
  });
});

describe("loadBlockFeedFromR2Sql", () => {
  test("returns a feed shaped by the SHARED formatter", async () => {
    const { impl, queries } = sqlFetch([row(10), row(9)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 2,
      offset: 0,
    });
    assert.ok(data);
    assert.equal(data!.blocks.length, 2);
    // Formatter-owned fields prove buildBlockFeed ran, not a local reshape.
    assert.equal(data!.blocks[0]!.block_number, 10);
    assert.match(queries[0]!, /FROM chain\.blocks/);
    assert.match(
      queries[0]!,
      /ORDER BY observed_at DESC, block_number DESC LIMIT 2/,
      "the exact composite key the cursor token encodes",
    );
  });

  test("emulates OFFSET by over-fetching and slicing, since R2 SQL has none", async () => {
    const { impl, queries } = sqlFetch([row(10), row(9), row(8), row(7)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 2,
      offset: 2,
    });
    assert.match(queries[0]!, /LIMIT 4/, "asked for limit+offset");
    assert.ok(!/OFFSET/i.test(queries[0]!), "never emits an OFFSET clause");
    assert.equal(data!.blocks[0]!.block_number, 8);
    assert.equal(data!.blocks.length, 2);
  });

  test("the cap check RECORDS the decline it takes (#11142)", () => {
    // The counter is the only way a declined page can be told from an empty
    // one: the cap is checked before any SQL is built, so the r2-sql failure
    // generation -- which is what handleRequest compares around a dispatch --
    // never moves. A bare `offset > CAP` comparison is therefore invisible to
    // the labeller, which is how ten routes shipped answering a declined page
    // as end-of-feed.
    const start = currentOffsetCapDeclineGeneration();

    // At or below the ceiling: servable, and nothing to declare.
    assert.equal(offsetBeyondEmulationCap(0), false);
    assert.equal(offsetBeyondEmulationCap(OFFSET_EMULATION_CAP), false);
    assert.equal(
      currentOffsetCapDeclineGeneration(),
      start,
      "a servable depth must not report a decline, or the marker means nothing",
    );

    // Past it: declined, and said so.
    assert.equal(offsetBeyondEmulationCap(OFFSET_EMULATION_CAP + 1), true);
    assert.equal(currentOffsetCapDeclineGeneration(), start + 1);
    assert.equal(offsetBeyondEmulationCap(OFFSET_EMULATION_CAP + 10_000), true);
    assert.equal(
      currentOffsetCapDeclineGeneration(),
      start + 2,
      "each decline counts, so concurrent reads on one isolate cannot mask one another",
    );
  });

  test("the offset cap keeps the worst measured page under the body cap (#11140)", () => {
    // NOT `OFFSET_EMULATION_CAP === 250` -- that asserts the code's own
    // assumption and passes at any value. This pins the ARITHMETIC the constant
    // exists to satisfy, so raising it back fails here with the reason.
    //
    // The over-fetch is `limit + offset` rows (R2 SQL has no OFFSET), each
    // carrying an unbounded `call_args`. Measured 2026-08-14 on
    // chain_detail_extrinsics: a filtered read concentrates the wide rows, and
    // the density that actually declined in production implies ~11.4 KB/row --
    // that page tripped a 12 MB cap, so the cap is not the free variable.
    // Imported, not retyped: raising the limit ceiling widens the same
    // over-fetch, so this must fail then too rather than pass on a stale 100.
    const MAX_PAGE_LIMIT = CHAIN_EVENTS_LIMIT_MAX;
    const OBSERVED_WIDE_ROW_BYTES = 11_400;
    const PRODUCTION_BODY_CAP = 8 * 1024 * 1024;

    const worstFetch = OFFSET_EMULATION_CAP + MAX_PAGE_LIMIT;
    const worstBytes = worstFetch * OBSERVED_WIDE_ROW_BYTES;
    assert.ok(
      worstBytes < PRODUCTION_BODY_CAP,
      `an emulated-offset page may fetch ${worstFetch} rows, which is ` +
        `${worstBytes} bytes at the observed wide-row density and exceeds the ` +
        `${PRODUCTION_BODY_CAP}-byte cap. Lower OFFSET_EMULATION_CAP; do not ` +
        `raise the body cap -- 8 MB was already raised to 12 MB and still declined.`,
    );
    // And the margin is real, not a hair under: at least 2x headroom, so an
    // era with denser payloads than the one measured does not reintroduce it.
    assert.ok(
      worstBytes * 2 < PRODUCTION_BODY_CAP,
      "the offset cap should leave at least 2x headroom against the body cap",
    );
  });

  test("declines a too-deep offset rather than scanning for it", async () => {
    const { impl, queries } = sqlFetch([]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 10,
      offset: OFFSET_EMULATION_CAP + 1,
    });
    assert.equal(data, null);
    assert.equal(queries.length, 0, "no query issued at all");
  });

  test("applies every supported filter, and only as validated literals", async () => {
    const { impl, queries } = sqlFetch([row(5)]);
    globalThis.fetch = impl;
    await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 5,
      offset: 0,
      author: AUTHOR,
      specVersion: 240,
      blockStart: 100,
      blockEnd: 900,
      minExtrinsics: 2,
      minEvents: 1,
      from: 1_700_000_000_000,
      to: 1_800_000_000_000,
      cursor: "1700000000950.950",
    } as never);
    const q = queries[0]!;
    assert.match(q, new RegExp(`author = '${AUTHOR}'`));
    assert.match(q, /spec_version = 240/);
    assert.match(q, /block_number >= 100/);
    assert.match(q, /block_number <= 900/);
    assert.match(q, /observed_at >= 1700000000000/);
    assert.match(q, /observed_at <= 1800000000000/);
    assert.match(q, /extrinsic_count >= 2/);
    assert.match(q, /event_count >= 1/);
    // The EXACT tuple seek data-api issues for the same token.
    assert.match(q, /\(observed_at, block_number\) < \(1700000000950, 950\)/);
  });

  test("DECLINES on an unsafe author instead of dropping the filter", async () => {
    const { impl, queries } = sqlFetch([row(1)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 5,
      offset: 0,
      author: "'; DROP TABLE chain.blocks; --",
    } as never);
    assert.equal(
      data,
      null,
      "a filter we cannot express must not widen the result set",
    );
    assert.equal(queries.length, 0);
  });

  test("declines on an unsafe numeric filter", async () => {
    const { impl } = sqlFetch([row(1)]);
    globalThis.fetch = impl;
    for (const bad of [
      { limit: 5, offset: 0, specVersion: "abc" },
      { limit: 5, offset: 0, blockStart: -3 },
      { limit: 5, offset: 0, from: "abc" },
      { limit: 0, offset: 0 },
      // an offset that is not a number at all
      { limit: 5, offset: "abc" },
    ]) {
      assert.equal(
        await loadBlockFeedFromR2Sql(mockEnv(TOKEN), bad as never),
        null,
        JSON.stringify(bad),
      );
    }
  });

  test("a malformed cursor token means page 1 -- data-api's exact behavior", async () => {
    const { impl, queries } = sqlFetch([row(9)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 5,
      offset: 0,
      cursor: "junk",
    } as never);
    assert.ok(data, "parity: the same page the Postgres tier would serve");
    assert.ok(!/junk/.test(queries[0]!), "the bad token never reaches SQL");
  });

  test("a cursor page ignores offset, mirroring data-api", async () => {
    const { impl, queries } = sqlFetch([row(9), row(8)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 2,
      offset: 5,
      cursor: "1700000000009.9",
    } as never);
    assert.match(queries[0]!, /LIMIT 2/, "no over-fetch on a cursor page");
    assert.equal(data!.blocks.length, 2);
  });

  test("an omitted offset defaults to zero rather than declining", async () => {
    const { impl, queries } = sqlFetch([row(4)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 5,
    } as never);
    assert.ok(data, "offset is optional");
    assert.match(
      queries[0]!,
      /LIMIT 5/,
      "no over-fetch when there is no offset",
    );
  });

  test("a query failure yields null so the caller keeps its empty fallback", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadBlockFeedFromR2Sql(mockEnv(TOKEN), { limit: 5, offset: 0 }),
      null,
    );
  });

  test("a short page carries no next cursor", async () => {
    const { impl } = sqlFetch([row(3)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 5,
      offset: 0,
    });
    assert.equal(data!.next_cursor ?? null, null);
  });

  test("a full page carries the Postgres tier's own token format", async () => {
    const { impl } = sqlFetch([row(9), row(8)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 2,
      offset: 0,
    });
    // observed_at.block_number -- the same dot-joined token data-api emits,
    // so paging survives a tier transition in either direction.
    assert.equal(data!.next_cursor, "1700000000008.8");
  });
});

describe("loadBlockFromR2Sql", () => {
  test("resolves by height, and its neighbours ride the SAME query", async () => {
    // #11462. `prev_block_number`/`next_block_number` were permanently null on
    // this tier, so #1853's chain-walk nav was structurally present and dead on
    // the tier that answers the route. The Postgres tier gets them from a
    // second query; here the ref IS the height, so widening `= N` to
    // `N-1 .. N+1` returns the block and both neighbours in one read -- no
    // extra warehouse query on a route that has been rate-limited before.
    const { impl, queries } = sqlFetch([
      row(8754999),
      row(8755000),
      row(8755001),
    ]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "8755000");
    assert.equal(queries.length, 1, "one query, not two");
    assert.match(
      queries[0]!,
      /block_number >= 8754999 AND block_number <= 8755001/,
    );
    assert.equal(data!.block!.block_number, 8755000, "the asked-for height");
    assert.equal(data!.prev_block_number, 8754999);
    assert.equal(data!.next_block_number, 8755001);
  });

  test("a neighbour this tier does NOT hold is null, not arithmetic", async () => {
    // PRESENCE, never `height +/- 1`. Arithmetic would advertise a block at a
    // coverage edge that the API cannot then serve, and a chain-walk link into
    // a gap is worse than a null saying the walk stops here. The head has no
    // next and genesis no prev, and both fall out of the same rule.
    const { impl } = sqlFetch([row(8754999), row(8755000)]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "8755000");
    assert.equal(data!.prev_block_number, 8754999);
    assert.equal(data!.next_block_number, null, "absent means null");
  });

  test("the range never asks for a negative height at genesis", async () => {
    const { impl, queries } = sqlFetch([row(0)]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "0");
    assert.match(queries[0]!, /block_number >= 0 AND block_number <= 1/);
    assert.equal(data!.prev_block_number, null);
  });

  test("a range that does NOT contain the asked height is still an absence", async () => {
    // The neighbours can come back without the block itself -- a gap at exactly
    // N. Picking `rows[0]` would then serve block N-1 under a ref for N, which
    // is a wrong answer rather than a missing one.
    const { impl } = sqlFetch([row(8754999), row(8755001)]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "8755000");
    assert.equal(data!.block, null, "no row for N is no block");
    assert.equal(
      data!.prev_block_number,
      null,
      "and buildBlock withholds nav without a block to walk from",
    );
  });

  test("resolves by hash, lowercased", async () => {
    const { impl, queries } = sqlFetch([row(42)]);
    globalThis.fetch = impl;
    await loadBlockFromR2Sql(mockEnv(TOKEN), "0xABCDEF");
    assert.match(queries[0]!, /block_hash = '0xabcdef'/);
  });

  test("a hash ref gets nav too, from a second read of its heights", async () => {
    // The one path that cannot fold the neighbours in: the height is unknown
    // until the row returns. It pays the extra query rather than leaving nav
    // null on half the ref forms -- intermittent nav reads as data rather than
    // as a tier limit, which is worse than none.
    const { impl, queries } = sqlFetchSeq([
      [row(42)],
      [{ block_number: 41 }, { block_number: 42 }, { block_number: 43 }],
    ]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "0xABCDEF");
    assert.equal(queries.length, 2);
    assert.match(queries[1]!, /block_number >= 41 AND block_number <= 43/);
    assert.match(
      queries[1]!,
      /SELECT block_number FROM/,
      "one column, the cheapest shape this engine has",
    );
    assert.equal(data!.block!.block_number, 42);
    assert.equal(data!.prev_block_number, 41);
    assert.equal(data!.next_block_number, 43);
  });

  test("a hash row with an unusable height serves the block and asks no more", async () => {
    // The height is what the neighbour read is keyed on, so an unreadable one
    // means there is nothing to ask for. Issuing the second query anyway would
    // spend a warehouse read to bound a range around NaN.
    const { impl, queries } = sqlFetchSeq([
      [{ ...row(42), block_number: null }],
    ]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "0xABCDEF");
    assert.equal(queries.length, 1, "no neighbour read without a height");
    assert.equal(data!.prev_block_number, null);
    assert.equal(data!.next_block_number, null);
  });

  test("a failed neighbour read still serves the block", async () => {
    // Nav is a hint; the block is the answer. Declining the whole payload
    // because a navigation aid could not be read would trade the thing the
    // caller asked for against the thing it did not.
    const { impl } = sqlFetchSeq([[row(42)], null]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "0xABCDEF");
    assert.equal(data!.block!.block_number, 42, "the block still lands");
    assert.equal(data!.prev_block_number, null);
    assert.equal(data!.next_block_number, null);
  });

  test("a confirmed absence is the shared no-such-block payload, not null", async () => {
    const { impl } = sqlFetch([]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "999999999");
    assert.ok(data, "an absence is an answer");
    assert.equal(data!.block ?? null, null);
  });

  test("refuses a ref that is neither a height nor a hash", async () => {
    const { impl, queries } = sqlFetch([]);
    globalThis.fetch = impl;
    assert.equal(
      await loadBlockFromR2Sql(mockEnv(TOKEN), "'; DROP TABLE --"),
      null,
    );
    assert.equal(queries.length, 0);
  });

  test("a failed query is MARKED, so it is not a false absence", async () => {
    // This test's intent was always right and its assertion could not carry it
    // (#11424): `null` was returned precisely so a failed read would not be
    // "mistaken for 'no such block'", and the caller then rebuilt exactly that
    // payload from the null. The distinction now rides on the payload itself,
    // where a consumer can see it.
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const out = await loadBlockFromR2Sql(mockEnv(TOKEN), "10");
    assert.ok(out, "a decline still answers");
    assert.equal(out.block, null);
    assert.deepEqual(
      out.degraded,
      { reason: "unavailable" },
      "must not be mistaken for 'no such block'",
    );
  });
});

describe("loadBlockWithEconomicsFromR2Sql", () => {
  test("derives complete block economics and subnet involvement from companion tables", async () => {
    const { impl, queries } = sqlFetchByQuery((query) => {
      if (/FROM chain\.blocks/.test(query)) return [row(41), row(42), row(43)];
      if (/FROM chain\.extrinsics/.test(query))
        return [
          economicsExtrinsic(),
          economicsExtrinsic({
            extrinsic_index: 1,
            signer: null,
            fee_tao: null,
            tip_tao: null,
          }),
        ];
      if (/FROM chain\.account_events/.test(query))
        return [
          economicsEvent(),
          economicsEvent({
            event_index: 1,
            event_kind: "StakeAdded",
            amount_tao: 1.25,
          }),
          economicsEvent({
            event_index: 2,
            event_kind: "Issued",
            amount_tao: 0.5,
            netuid: null,
          }),
          economicsEvent({
            event_index: 3,
            amount_tao: 0.000000113,
            netuid: null,
          }),
        ];
      return null;
    });
    globalThis.fetch = impl;

    const data = await loadBlockWithEconomicsFromR2Sql(mockEnv(TOKEN), "42");
    assert.ok(data?.block);
    assert.equal(data.block.decode_status, "complete");
    assert.equal(data.block.native_transfer_tao, 2.500000113);
    assert.equal(data.block.stake_flow_tao, 1.25);
    assert.equal(data.block.economic_activity_tao, 3.750000113);
    assert.equal(data.block.fee_tao, 0.125);
    assert.equal(data.block.tip_tao, 0.005);
    assert.equal(data.block.issuance_tao, 0.5);
    assert.deepEqual(data.block.subnet_ids, [7, 19]);
    assert.equal(data.prev_block_number, 41);
    assert.equal(data.next_block_number, 43);
    assert.equal(queries.length, 3, "one header and two concurrent companions");
    assert.match(
      queries.find((q) => /chain\.extrinsics/.test(q))!,
      /block_number = 42/,
    );
    assert.match(
      queries.find((q) => /chain\.account_events/.test(q))!,
      /block_number = 42/,
    );
  });

  for (const failedTable of ["extrinsics", "account_events"] as const) {
    test(`keeps economics unavailable when ${failedTable} fails`, async () => {
      const { impl } = sqlFetchByQuery((query) => {
        if (/FROM chain\.blocks/.test(query)) return [row(42)];
        if (query.includes(`chain.${failedTable}`)) return null;
        return [];
      });
      globalThis.fetch = impl;

      const data = await loadBlockWithEconomicsFromR2Sql(mockEnv(TOKEN), "42");
      assert.ok(data?.block, "the header is still an answer");
      assert.equal(data.block.decode_status, "unavailable");
      assert.equal(data.block.economic_activity_tao, null);
      assert.deepEqual(data.block.subnet_ids, []);
    });
  }

  test("resolves a hash before querying its companion rows", async () => {
    const { impl, queries } = sqlFetchByQuery((query) => {
      if (/block_hash = '0xabcdef'/.test(query)) return [row(42)];
      if (/SELECT block_number FROM chain\.blocks/.test(query))
        return [
          { block_number: 41 },
          { block_number: 42 },
          { block_number: 43 },
        ];
      if (/FROM chain\.extrinsics/.test(query)) return [];
      if (/FROM chain\.account_events/.test(query)) return [];
      return null;
    });
    globalThis.fetch = impl;

    const data = await loadBlockWithEconomicsFromR2Sql(
      mockEnv(TOKEN),
      "0xABCDEF",
    );
    assert.ok(data?.block);
    assert.equal(data.block.block_number, 42);
    assert.equal(data.block.decode_status, "complete");
    assert.equal(data.block.economic_activity_tao, 0);
    assert.equal(queries.length, 4, "hash, neighbours, and two companions");
    for (const query of queries.filter((q) =>
      /extrinsics|account_events/.test(q),
    )) {
      assert.match(query, /block_number = 42/);
    }
  });

  test("keeps a hash-resolved block when its economics read declines", async () => {
    const { impl } = sqlFetchByQuery((query) => {
      if (/block_hash = '0xabcdef'/.test(query)) return [row(42)];
      if (/SELECT block_number FROM chain\.blocks/.test(query)) return [];
      if (/FROM chain\.extrinsics/.test(query)) return null;
      return [];
    });
    globalThis.fetch = impl;

    const data = await loadBlockWithEconomicsFromR2Sql(
      mockEnv(TOKEN),
      "0xABCDEF",
    );
    assert.ok(data?.block);
    assert.equal(data.block.decode_status, "unavailable");
  });

  test("does not manufacture a block when the header is absent", async () => {
    const { impl } = sqlFetchByQuery((query) =>
      /FROM chain\.blocks/.test(query) ? [] : [],
    );
    globalThis.fetch = impl;
    const data = await loadBlockWithEconomicsFromR2Sql(mockEnv(TOKEN), "42");
    assert.ok(data);
    assert.equal(data.block, null);
  });

  test("rejects an invalid ref before issuing a query", async () => {
    const { impl, queries } = sqlFetchByQuery(() => []);
    globalThis.fetch = impl;
    assert.equal(
      await loadBlockWithEconomicsFromR2Sql(mockEnv(TOKEN), "not-a-block-ref"),
      null,
    );
    assert.equal(queries.length, 0);
  });
});
