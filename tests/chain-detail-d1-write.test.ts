// The chain-detail write path's statements (#9208).
//
// Two properties, and the first one has already cost this repo fifteen failed
// production syncs on a sibling lane:
//
//   1. NO STATEMENT EXCEEDS THE BINDING'S 100-PARAMETER LIMIT. The Workers D1
//      binding enforces it (the wrangler/HTTP path does not), so a chunk sized
//      by anything other than the column count is a live failure nothing local
//      catches.
//   2. THE COVERAGE REGISTER IS WRITTEN LAST. A block row is the claim "this
//      block's detail is queryable", and the read path treats it as
//      authoritative including for an EMPTY answer -- so advertising coverage
//      before the rows land would make an in-flight block read as a measured
//      zero, which is the exact ambiguity #9208 exists to kill.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
  CHAIN_DETAIL_BLOCK_COLUMNS,
  CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
  CHAIN_DETAIL_EXTRINSIC_COLUMNS,
  D1_PARAM_BUDGET,
  buildChainDetailUpsert,
  chunkChainDetailStatements,
  writeChainDetailToD1,
} from "../src/chain-detail-d1-write.ts";

interface Recorded {
  sql: string;
  params: unknown[];
}

function fakeDb(opts: { throws?: boolean } = {}) {
  const statements: Recorded[] = [];
  const batches: number[] = [];
  const db = {
    prepare(sql: string) {
      const record: Recorded = { sql, params: [] };
      return {
        bind(...values: unknown[]) {
          record.params = values;
          statements.push(record);
          return record as never;
        },
      };
    },
    async batch(slice: unknown[]) {
      if (opts.throws) throw new Error("d1 down");
      batches.push(slice.length);
      return [];
    },
  };
  return { db: db as never, statements, batches };
}

function rows(table: string[], count: number, base = 0) {
  return Array.from({ length: count }, (_, i) => {
    const row: Record<string, unknown> = {};
    for (const column of table) row[column] = `${column}-${base + i}`;
    return row;
  });
}

describe("buildChainDetailUpsert", () => {
  test("upserts on the natural key with no staleness guard", () => {
    const sql = buildChainDetailUpsert(
      "chain_detail_extrinsics",
      ["block_number", "extrinsic_index", "signer"],
      ["block_number", "extrinsic_index"],
      2,
    );
    assert.match(sql, /VALUES \(\?, \?, \?\), \(\?, \?, \?\)/);
    assert.match(
      sql,
      /ON CONFLICT \(block_number, extrinsic_index\) DO UPDATE SET signer = excluded\.signer/,
    );
    // The neurons writer's `captured_at <= excluded.captured_at` guard must NOT
    // appear: these rows describe a finalized block, so "newer" is meaningless
    // and a guard would silently drop a legitimate rewrite.
    assert.doesNotMatch(sql, /WHERE/);
    // Key columns are never in the SET list -- updating a column to itself is
    // noise, and SQLite rejects some forms of it.
    assert.doesNotMatch(sql, /block_number = excluded\.block_number/);
  });
});

describe("chunkChainDetailStatements", () => {
  test("no statement exceeds the binding's parameter budget", () => {
    for (const columns of [
      CHAIN_DETAIL_BLOCK_COLUMNS,
      CHAIN_DETAIL_EXTRINSIC_COLUMNS,
      CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
      CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
    ]) {
      const { db, statements } = fakeDb();
      chunkChainDetailStatements(
        db,
        "chain_detail_extrinsics",
        columns,
        rows(columns, 500),
      );
      assert.ok(statements.length > 1, "500 rows must chunk");
      for (const statement of statements) {
        assert.ok(
          statement.params.length <= D1_PARAM_BUDGET,
          `${statement.params.length} bound params exceeds the ${D1_PARAM_BUDGET} budget`,
        );
        assert.equal(statement.params.length % columns.length, 0);
      }
    }
  });

  test("values are bound in column order, with absent fields as null", () => {
    const { db, statements } = fakeDb();
    chunkChainDetailStatements(
      db,
      "chain_detail_blocks",
      ["block_number", "block_hash", "spec_version"],
      [{ block_number: 7, block_hash: "0xabc" }],
    );
    assert.deepEqual(statements[0].params, [7, "0xabc", null]);
  });

  test("no rows means no statements", () => {
    const { db, statements } = fakeDb();
    chunkChainDetailStatements(db, "chain_detail_blocks", ["block_number"], []);
    assert.equal(statements.length, 0);
  });
});

describe("writeChainDetailToD1", () => {
  test("writes the coverage register LAST, after all three row families", async () => {
    const { db, statements, batches } = fakeDb();
    const result = await writeChainDetailToD1(db, {
      blockRows: rows(CHAIN_DETAIL_BLOCK_COLUMNS, 2),
      extrinsicRows: rows(CHAIN_DETAIL_EXTRINSIC_COLUMNS, 30),
      chainEventRows: rows(CHAIN_DETAIL_CHAIN_EVENT_COLUMNS, 60),
      accountEventRows: rows(CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS, 40),
    });
    assert.equal(result.statements, statements.length);
    assert.equal(batches.length, 1);

    const tables = statements.map(
      (s) => /INSERT INTO (\w+)/.exec(s.sql)?.[1] ?? "",
    );
    const lastRegister = tables.lastIndexOf("chain_detail_blocks");
    const firstRegister = tables.indexOf("chain_detail_blocks");
    assert.equal(
      lastRegister,
      tables.length - 1,
      "the register must be the final statement",
    );
    for (const table of [
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
      "chain_detail_account_events",
    ]) {
      assert.ok(
        tables.lastIndexOf(table) < firstRegister,
        `${table} must be written before the coverage register`,
      );
    }
  });

  test("an empty batch issues no D1 call at all", async () => {
    const { db, batches } = fakeDb();
    const result = await writeChainDetailToD1(db, {
      blockRows: [],
      extrinsicRows: [],
      chainEventRows: [],
      accountEventRows: [],
    });
    assert.equal(result.statements, 0);
    assert.deepEqual(batches, []);
  });

  test("a D1 failure propagates -- the handler owns the 502, not this module", async () => {
    const { db } = fakeDb({ throws: true });
    await assert.rejects(
      writeChainDetailToD1(db, {
        blockRows: rows(CHAIN_DETAIL_BLOCK_COLUMNS, 1),
        extrinsicRows: [],
        chainEventRows: [],
        accountEventRows: [],
      }),
      /d1 down/,
    );
  });
});
