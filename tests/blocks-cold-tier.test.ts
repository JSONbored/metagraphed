// The properties that make the two-source block tier trustworthy:
//   1. THE SEAM IS EXACT — every block comes from exactly one source, so a
//      stitched page can neither duplicate nor drop a block at the boundary.
//   2. NO SILENT WIDENING — a filter over a column blocks_head lacks must not
//      be answered with D1 rows that ignore it.
//   3. ONE FORMATTING PASS — rows from both sources go through the shared
//      formatter together, never formatted twice.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import {
  blocksSeamFloor,
  d1CanServe,
  DEFAULT_BLOCKS_SEAM,
  loadBlockColdTier,
  loadBlockFeedColdTier,
  resolveBlocksSeam,
} from "../src/blocks-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import {
  DECODE_WATERMARK_KEY,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";

const SEAM = DEFAULT_BLOCKS_SEAM; // 8_759_336

// The watermark memo is module state that outlives a test. Without this, the
// first test to publish one silently moves the seam for every test after it.
beforeEach(() => resetDecodeWatermarkCache());

/** A D1 stub that records the SQL it was asked for. */
function d1(rows: Record<string, unknown>[], opts: { throws?: boolean } = {}) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    db: {
      prepare(q: string) {
        sql.push(q.replace(/\s+/g, " ").trim());
        return {
          bind(...values: unknown[]) {
            params.push(values);
            return {
              async all() {
                if (opts.throws) throw new Error("d1 cold");
                return { results: rows };
              },
            };
          },
        };
      },
    },
  };
}

function headRow(n: number) {
  return {
    block_number: n,
    block_hash: `0xhead${n}`,
    parent_hash: `0xhead${n - 1}`,
    extrinsic_count: 2,
    observed_at: 1_700_000_000_000 + n,
  };
}

function lakeRow(n: number) {
  return {
    block_number: n,
    block_hash: `0xlake${n}`,
    parent_hash: `0xlake${n - 1}`,
    author: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
    extrinsic_count: 3,
    event_count: 7,
    spec_version: 240,
    observed_at: 1_700_000_000_000 + n,
  };
}

/** Stub R2 SQL transport; captures the queries the lakehouse leg issued. */
function lakeFetch(rows: unknown[]) {
  const queries: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

/** A bucket stub serving one watermark body (or nothing). */
function archive(body: unknown) {
  return {
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (key !== DECODE_WATERMARK_KEY || body === undefined) return null;
        return {
          async text() {
            return JSON.stringify(body);
          },
        };
      },
    },
  };
}

describe("blocksSeamFloor", () => {
  test("defaults to the verified lakehouse maximum", () => {
    assert.equal(blocksSeamFloor(undefined), DEFAULT_BLOCKS_SEAM);
    assert.equal(blocksSeamFloor({}), DEFAULT_BLOCKS_SEAM);
  });

  test("is overridable so a deployment can raise its own floor", () => {
    assert.equal(blocksSeamFloor({ ICEBERG_BLOCKS_MAX: "9000000" }), 9_000_000);
  });

  test("a malformed override falls back rather than serving from block 0", () => {
    // Number("abc") is NaN but Number("") is 0 -- an unguarded parse would put
    // the seam at 0 and route the ENTIRE chain to D1, which holds days of it.
    for (const bad of ["abc", "", "-5", "1.5"]) {
      assert.equal(
        blocksSeamFloor({ ICEBERG_BLOCKS_MAX: bad }),
        DEFAULT_BLOCKS_SEAM,
      );
    }
  });
});

describe("resolveBlocksSeam — the constant is a FLOOR, never a ceiling", () => {
  test("a published watermark ahead of the floor moves the seam", async () => {
    // The whole point: the decode lane extends the lakehouse hourly and the
    // Worker follows without a deploy.
    assert.equal(
      await resolveBlocksSeam(archive({ decoded_through: SEAM + 4_000 })),
      SEAM + 4_000,
    );
  });

  test("no watermark at all leaves the floor exactly where it was", async () => {
    assert.equal(await resolveBlocksSeam({}), DEFAULT_BLOCKS_SEAM);
    assert.equal(await resolveBlocksSeam(archive(undefined)), SEAM);
  });

  test("a watermark BEHIND the floor cannot lower the seam", async () => {
    // A regressed watermark (a rolled-back ledger, a half-written object) must
    // not un-serve verified history the lakehouse still holds.
    assert.equal(
      await resolveBlocksSeam(archive({ decoded_through: 1 })),
      SEAM,
    );
  });

  test("a malformed watermark falls back instead of guessing", async () => {
    for (const body of [{}, { decoded_through: "later" }, "nonsense", null]) {
      resetDecodeWatermarkCache();
      assert.equal(await resolveBlocksSeam(archive(body)), SEAM);
    }
  });

  test("the env floor still wins when it is the higher of the two", async () => {
    assert.equal(
      await resolveBlocksSeam({
        ...archive({ decoded_through: SEAM + 10 }),
        ICEBERG_BLOCKS_MAX: String(SEAM + 5_000),
      }),
      SEAM + 5_000,
    );
  });
});

describe("the resolved seam actually routes the request", () => {
  test("a block above the constant but below the watermark reads from the lake", async () => {
    // The production bug, as a test: block SEAM+3264 was served from D1 with
    // null author/spec_version/event_count while the lakehouse held it.
    const above = SEAM + 3_264;
    const { db, sql } = d1([headRow(above)]);
    const queries = lakeFetch([lakeRow(above)]);
    const data = await loadBlockColdTier(
      {
        ...TOKEN,
        ...archive({ decoded_through: above }),
        METAGRAPH_HEALTH_DB: db,
      } as never,
      String(above),
    );
    assert.deepEqual(sql, [], "D1 must not be asked for a decoded block");
    assert.match(queries[0]!, new RegExp(`block_number = ${above}`));
    assert.equal(data!.block!.author, lakeRow(above).author);
  });

  test("the D1 leg's floor moves with the watermark, not with the constant", async () => {
    const { db, params } = d1([headRow(SEAM + 5_000)]);
    lakeFetch([]);
    await loadBlockFeedColdTier(
      {
        ...TOKEN,
        ...archive({ decoded_through: SEAM + 4_000 }),
        METAGRAPH_HEALTH_DB: db,
      } as never,
      { limit: 1, offset: 0 },
    );
    assert.equal(
      params[0]![0],
      SEAM + 4_000,
      "the head leg is bounded by the resolved seam, not DEFAULT_BLOCKS_SEAM",
    );
  });
});

describe("d1CanServe", () => {
  test("accepts filters blocks_head can express", () => {
    assert.equal(d1CanServe({ limit: 5, offset: 0 }), true);
    assert.equal(
      d1CanServe({ limit: 5, offset: 0, minExtrinsics: 2, blockStart: 10 }),
      true,
    );
  });

  test("rejects filters over columns blocks_head does not have", () => {
    assert.equal(d1CanServe({ limit: 5, offset: 0, author: "x" }), false);
    assert.equal(d1CanServe({ limit: 5, offset: 0, specVersion: 1 }), false);
    assert.equal(d1CanServe({ limit: 5, offset: 0, minEvents: 1 }), false);
  });
});

describe("loadBlockFeedColdTier", () => {
  test("serves entirely from D1 when the page fits above the seam", async () => {
    const { db, sql, params } = d1([headRow(SEAM + 3), headRow(SEAM + 2)]);
    const queries = lakeFetch([]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 2,
        offset: 0,
      },
    );
    assert.equal(data!.blocks.length, 2);
    assert.equal(data!.blocks[0]!.block_number, SEAM + 3);
    assert.match(sql[0]!, /block_number > \?/);
    assert.equal(params[0]![0], SEAM, "the seam is the D1 floor");
    assert.equal(queries.length, 0, "no lakehouse query needed");
  });

  test("stitches D1 then the lakehouse, strictly below the last D1 row", async () => {
    const { db } = d1([headRow(SEAM + 1)]);
    const queries = lakeFetch([lakeRow(SEAM), lakeRow(SEAM - 1)]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 3,
        offset: 0,
      },
    );
    assert.deepEqual(
      data!.blocks.map((b) => b.block_number),
      [SEAM + 1, SEAM, SEAM - 1],
      "contiguous across the seam, in order, no duplicate",
    );
    assert.match(
      queries[0]!,
      new RegExp(
        `\\(observed_at, block_number\\) < \\(${1_700_000_000_000 + SEAM + 1}, ${SEAM + 1}\\)`,
      ),
      "continues via the last D1 row's own cursor token",
    );
  });

  test("with no D1 rows the lakehouse leg starts at the seam itself", async () => {
    const { db } = d1([]);
    const queries = lakeFetch([lakeRow(SEAM)]);
    await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 1,
        offset: 0,
      },
    );
    // No D1 rows -> an exclusive block ceiling at the seam, not a tuple seek.
    assert.match(queries[0]!, new RegExp(`block_number < ${SEAM + 1}`));
  });

  test("a filter D1 cannot express skips the D1 leg entirely", async () => {
    const { db, sql } = d1([headRow(SEAM + 1)]);
    const queries = lakeFetch([lakeRow(10)]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 5,
        offset: 0,
        author: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
      } as never,
    );
    assert.equal(sql.length, 0, "D1 was never queried");
    assert.equal(data!.blocks.length, 1);
    assert.match(
      queries[0]!,
      /author = '5EYC/,
      "the filter reached the lakehouse",
    );
  });

  test("offset is applied once, after both legs are concatenated", async () => {
    const { db } = d1([headRow(SEAM + 2), headRow(SEAM + 1)]);
    const queries = lakeFetch([lakeRow(SEAM), lakeRow(SEAM - 1)]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 2,
        offset: 2,
      },
    );
    assert.deepEqual(
      data!.blocks.map((b) => b.block_number),
      [SEAM, SEAM - 1],
      "skipped the two D1 rows, not two rows of each source",
    );
    assert.equal(queries.length, 1);
  });

  test("D1 rows are formatted ONCE, by the shared formatter", async () => {
    const { db } = d1([headRow(SEAM + 1)]);
    lakeFetch([]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 1,
        offset: 0,
      },
    );
    const b = data!.blocks[0]!;
    assert.equal(b.block_number, SEAM + 1);
    assert.equal(b.block_hash, `0xhead${SEAM + 1}`);
    // Columns blocks_head does not carry are null, not absent or invented.
    assert.equal(
      (b as unknown as Record<string, unknown>).author ?? null,
      null,
    );
  });

  test("a cold D1 degrades to the lakehouse rather than failing", async () => {
    const { db } = d1([], { throws: true });
    lakeFetch([lakeRow(SEAM)]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 1,
        offset: 0,
      },
    );
    assert.equal(data!.blocks.length, 1);
  });

  test("both sources failing yields null so the caller keeps its empty", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const data = await loadBlockFeedColdTier({ ...TOKEN } as never, {
      limit: 5,
      offset: 0,
    });
    assert.equal(data, null);
  });

  test("an invalid limit declines instead of guessing a page size", async () => {
    lakeFetch([]);
    for (const bad of [
      { limit: 0, offset: 0 },
      { limit: "x", offset: 0 },
    ]) {
      assert.equal(
        await loadBlockFeedColdTier({ ...TOKEN } as never, bad as never),
        null,
      );
    }
  });

  test("a full page carries a next cursor, a short page does not", async () => {
    const { db } = d1([headRow(SEAM + 2), headRow(SEAM + 1)]);
    lakeFetch([]);
    const full = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 2,
        offset: 0,
      },
    );
    // The Postgres tier's own token for this row: observed_at.block_number.
    assert.equal(
      full!.next_cursor,
      `${1_700_000_000_000 + SEAM + 1}.${SEAM + 1}`,
    );

    const { db: db2 } = d1([headRow(SEAM + 1)]);
    lakeFetch([]);
    const short = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db2 } as never,
      {
        limit: 5,
        offset: 0,
      },
    );
    assert.equal(short!.next_cursor ?? null, null);
  });

  test("an unbound D1 still serves the lakehouse range", async () => {
    lakeFetch([lakeRow(SEAM)]);
    const data = await loadBlockFeedColdTier({ ...TOKEN } as never, {
      limit: 1,
      offset: 0,
    });
    assert.equal(data!.blocks.length, 1);
  });

  test("range and count filters reach D1 as bound parameters", async () => {
    const { db, sql, params } = d1([headRow(SEAM + 5)]);
    lakeFetch([]);
    await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 1,
        offset: 0,
        cursor: `${1_700_000_000_000 + SEAM + 9}.${SEAM + 9}`,
        blockStart: SEAM + 1,
        blockEnd: SEAM + 8,
        from: 1_700_000_000_000,
        minExtrinsics: 2,
      } as never,
    );
    // Qualified to `b`: these columns exist on BOTH sides of the
    // chain_detail_blocks join, so an unqualified predicate is an ambiguous
    // -column error in SQLite rather than a silently wrong answer.
    assert.match(sql[0]!, /\(b\.observed_at, b\.block_number\) < \(\?, \?\)/);
    assert.match(sql[0]!, /b\.block_number >= \?/);
    assert.match(sql[0]!, /b\.block_number <= \?/);
    assert.match(sql[0]!, /b\.observed_at >= \?/);
    assert.match(sql[0]!, /b\.extrinsic_count >= \?/);
    // Bound, never interpolated — order matters as much as presence.
    assert.deepEqual(params[0], [
      SEAM,
      1_700_000_000_000 + SEAM + 9,
      SEAM + 9,
      SEAM + 1,
      SEAM + 8,
      1_700_000_000_000,
      2,
      1,
    ]);
  });

  test("an unparseable range filter declines rather than dropping it", async () => {
    for (const bad of [
      { blockStart: "abc" },
      { blockEnd: -2 },
      { minExtrinsics: "x" },
    ]) {
      const { db } = d1([headRow(SEAM + 1)]);
      lakeFetch([lakeRow(1)]);
      const data = await loadBlockFeedColdTier(
        { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
        { limit: 2, offset: 0, ...bad } as never,
      );
      assert.equal(data, null, JSON.stringify(bad));
    }
  });

  test("a non-array D1 result is treated as empty, not as rows", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: "not-an-array" }) }),
      }),
    };
    lakeFetch([lakeRow(SEAM)]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      { limit: 1, offset: 0 },
    );
    assert.equal(data!.blocks.length, 1);
    assert.equal(
      data!.blocks[0]!.block_number,
      SEAM,
      "came from the lakehouse",
    );
  });

  test("an omitted offset defaults to zero; a malformed one declines", async () => {
    const { db } = d1([headRow(SEAM + 1)]);
    lakeFetch([]);
    const ok = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      { limit: 2 } as never,
    );
    assert.ok(ok, "offset is optional");
    assert.equal(ok!.offset, 0);

    assert.equal(
      await loadBlockFeedColdTier(
        { ...TOKEN } as never,
        {
          limit: 2,
          offset: "abc",
        } as never,
      ),
      null,
    );
  });

  test("with no D1 rows the caller's cursor token reaches the lakehouse leg", async () => {
    const { db } = d1([]);
    const queries = lakeFetch([lakeRow(500)]);
    await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 1,
        offset: 0,
        cursor: "1700000000501.501",
      } as never,
    );
    assert.match(
      queries[0]!,
      /\(observed_at, block_number\) < \(1700000000501, 501\)/,
      "the caller's own token seeks the lake leg",
    );
  });

  test("D1 rows survive a lakehouse failure rather than being discarded", async () => {
    const { db } = d1([headRow(SEAM + 1)]);
    globalThis.fetch = (async () => {
      throw new Error("lakehouse down");
    }) as unknown as typeof fetch;
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      { limit: 5, offset: 0 },
    );
    assert.equal(data!.blocks.length, 1, "partial beats nothing");
    assert.equal(data!.blocks[0]!.block_number, SEAM + 1);
  });

  test("a full page whose last row has no usable height carries no cursor", async () => {
    const { db } = d1([{ ...headRow(SEAM + 1), block_number: "not-a-height" }]);
    lakeFetch([]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      { limit: 1, offset: 0 },
    );
    assert.equal(
      data!.next_cursor ?? null,
      null,
      "an unusable cursor is omitted, never emitted as garbage",
    );
  });

  test("an inverted range answers zero WITHOUT querying either source", async () => {
    const { db, sql } = d1([headRow(SEAM + 1)]);
    const queries = lakeFetch([lakeRow(5)]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      { limit: 5, offset: 0, blockStart: 20, blockEnd: 10 } as never,
    );
    assert.equal(data!.block_count, 0);
    assert.deepEqual(data!.blocks, []);
    assert.equal(sql.length, 0, "no D1 query");
    assert.equal(queries.length, 0, "no lakehouse query");
  });

  test("a malformed cursor token means page 1 -- data-api's exact behavior", async () => {
    // decodeCursor(junk) -> null -> no cursor, identical to the Postgres
    // tier. Parity means the SAME page for the SAME request on either tier,
    // malformed tokens included, so this must not decline.
    const { db, params } = d1([headRow(SEAM + 1)]);
    lakeFetch([]);
    const data = await loadBlockFeedColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      {
        limit: 2,
        offset: 0,
        cursor: "junk",
      } as never,
    );
    assert.ok(data, "page 1, not a decline");
    assert.deepEqual(params[0], [SEAM, 2], "no seek bound for a bad token");
  });
});

describe("loadBlockColdTier", () => {
  test("a height above the seam resolves from D1", async () => {
    const { db, params } = d1([headRow(SEAM + 5)]);
    const queries = lakeFetch([]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      String(SEAM + 5),
    );
    assert.equal(data!.block!.block_number, SEAM + 5);
    assert.equal(params[0]![0], SEAM + 5);
    assert.equal(queries.length, 0, "never touched the lakehouse");
  });

  test("a height at or below the seam goes straight to the lakehouse", async () => {
    const { db, sql } = d1([]);
    const queries = lakeFetch([lakeRow(SEAM)]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      String(SEAM),
    );
    assert.equal(data!.block!.block_number, SEAM);
    assert.equal(sql.length, 0, "D1 cannot own this height, so is not asked");
    assert.match(queries[0]!, new RegExp(`block_number = ${SEAM}`));
  });

  test("a height above the seam that D1 lacks is a real absence, not a scan", async () => {
    const { db } = d1([]);
    const queries = lakeFetch([]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      String(SEAM + 99),
    );
    assert.ok(data, "an absence is an answer");
    assert.equal(data!.block ?? null, null);
    assert.equal(
      queries.length,
      0,
      "the lakehouse cannot contain a block above the seam",
    );
  });

  test("a hash is asked of D1 first, then the lakehouse", async () => {
    const { db, sql } = d1([]);
    const queries = lakeFetch([lakeRow(42)]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      "0xABCD",
    );
    assert.match(sql[0]!, /lower\(b\.block_hash\) = \?/);
    assert.match(queries[0]!, /block_hash = '0xabcd'/);
    assert.equal(data!.block!.block_number, 42);
  });

  // The hot tier's coverage register (chain_detail_blocks) carries the two
  // columns blocks_head lacks. Before the join, a block above the seam always
  // published `event_count: null`, which the explorer rendered as "Events 0" --
  // on block 8,771,446 the same page's pallet breakdown said 320.
  test("a block the hot tier covers reports its event_count and spec_version", async () => {
    const { db } = d1([
      { ...headRow(SEAM + 4), spec_version: 442, event_count: 320 },
    ]);
    const queries = lakeFetch([]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      String(SEAM + 4),
    );
    assert.equal(data!.block!.event_count, 320);
    assert.equal(data!.block!.spec_version, 442);
    // Answered entirely above the seam -- the lakehouse is never asked.
    assert.equal(queries.length, 0);
  });

  // LEFT join: the hot tier keeps a shorter window than blocks_head, so a block
  // it has pruned past still resolves -- with an honest null, never a zero. A
  // count we do not have is not a count of zero.
  test("a block the hot tier has pruned past keeps a null count, not a zero", async () => {
    const { db } = d1([
      { ...headRow(SEAM + 4), spec_version: null, event_count: null },
    ]);
    lakeFetch([]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      String(SEAM + 4),
    );
    assert.equal(data!.block!.block_number, SEAM + 4);
    assert.equal(data!.block!.event_count, null);
    assert.equal(data!.block!.spec_version, null);
  });

  test("a hash D1 knows is served without touching the lakehouse", async () => {
    const { db } = d1([headRow(SEAM + 7)]);
    const queries = lakeFetch([]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      "0xabc123",
    );
    assert.equal(data!.block!.block_number, SEAM + 7);
    assert.equal(queries.length, 0);
  });

  test("refuses a ref that is neither a height nor a hash", async () => {
    const { db, sql } = d1([]);
    const queries = lakeFetch([]);
    assert.equal(
      await loadBlockColdTier(
        { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
        "'; DROP TABLE --",
      ),
      null,
    );
    assert.equal(sql.length, 0);
    assert.equal(queries.length, 0);
  });

  test("a throwing D1 falls through to the lakehouse", async () => {
    const { db } = d1([], { throws: true });
    lakeFetch([lakeRow(SEAM)]);
    const data = await loadBlockColdTier(
      { ...TOKEN, METAGRAPH_HEALTH_DB: db } as never,
      String(SEAM),
    );
    assert.equal(data!.block!.block_number, SEAM);
  });
});
