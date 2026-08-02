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
  OFFSET_EMULATION_CAP,
  safeAuthorLiteral,
} from "../src/r2-sql-blocks.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
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

/** Captures the SQL actually sent, which is what the filter assertions check. */
function sqlFetch(rows: unknown[]) {
  const queries: string[] = [];
  const impl = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
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
    assert.match(queries[0]!, /ORDER BY block_number DESC LIMIT 2/);
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
      cursor: 950,
    } as never);
    const q = queries[0]!;
    assert.match(q, new RegExp(`author = '${AUTHOR}'`));
    assert.match(q, /spec_version = 240/);
    assert.match(q, /block_number >= 100/);
    assert.match(q, /block_number <= 900/);
    assert.match(q, /extrinsic_count >= 2/);
    assert.match(q, /event_count >= 1/);
    assert.match(q, /block_number < 950/);
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

  test("declines on an unsafe numeric filter or cursor", async () => {
    const { impl } = sqlFetch([row(1)]);
    globalThis.fetch = impl;
    for (const bad of [
      { limit: 5, offset: 0, specVersion: "abc" },
      { limit: 5, offset: 0, blockStart: -3 },
      { limit: 5, offset: 0, cursor: "junk" },
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

  test("a full page carries the last block as the cursor", async () => {
    const { impl } = sqlFetch([row(9), row(8)]);
    globalThis.fetch = impl;
    const data = await loadBlockFeedFromR2Sql(mockEnv(TOKEN), {
      limit: 2,
      offset: 0,
    });
    assert.equal(data!.next_cursor, "8");
  });
});

describe("loadBlockFromR2Sql", () => {
  test("resolves by height", async () => {
    const { impl, queries } = sqlFetch([row(8755000)]);
    globalThis.fetch = impl;
    const data = await loadBlockFromR2Sql(mockEnv(TOKEN), "8755000");
    assert.match(queries[0]!, /block_number = 8755000/);
    assert.equal(data!.block!.block_number, 8755000);
  });

  test("resolves by hash, lowercased", async () => {
    const { impl, queries } = sqlFetch([row(42)]);
    globalThis.fetch = impl;
    await loadBlockFromR2Sql(mockEnv(TOKEN), "0xABCDEF");
    assert.match(queries[0]!, /block_hash = '0xabcdef'/);
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

  test("a failed query yields null, not a false absence", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadBlockFromR2Sql(mockEnv(TOKEN), "10"),
      null,
      "must not be mistaken for 'no such block'",
    );
  });
});
