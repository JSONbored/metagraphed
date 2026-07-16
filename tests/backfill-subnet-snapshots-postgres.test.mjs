// Unit tests for scripts/backfill-subnet-snapshots-postgres.mjs's pure
// helpers (SQL-literal encoding, statement batching, arg parsing, and the D1
// paging loop with an injected subprocess runner). Not part of the codecov
// coverage.include scope (see vitest.config.mjs's own comment on why only a
// named subset of scripts/ is instrumented) -- these tests exist for
// correctness confidence before running the script against production, the
// same convention tests/registry-sync-client.test.mjs already follows for
// scripts/backfill-registry-postgres.mjs's sibling helpers.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildBackfillSql,
  chunkRows,
  fetchAllRows,
  fetchPage,
  insertStatement,
  parseArgs,
  rowTuple,
  sqlLiteral,
} from "../scripts/backfill-subnet-snapshots-postgres.mjs";
import { chunkRows as sharedChunkRows } from "../scripts/lib.mjs";

const SAMPLE_ROW = {
  rowid: 1,
  netuid: 43,
  snapshot_date: "2025-06-23",
  completeness_score: 80,
  surface_count: 3,
  endpoint_count: 2,
  monitored_count: 1,
  candidate_count: 0,
  captured_at: 1750643200000,
  validator_count: 64,
  miner_count: 192,
  total_stake_tao: 123.456,
  alpha_price_tao: 0.789,
  emission_share: 0.0123,
  tao_in_pool_tao: 26707.57,
  alpha_in_pool: 2956464.98,
  alpha_out_pool: 2257199.02,
  subnet_volume_tao: 798027.45,
};

test("parseArgs returns defaults with no arguments", () => {
  const args = parseArgs([]);
  assert.equal(args.database, "metagraphed-health");
  assert.equal(args.pageSize, 3000);
  assert.equal(args.rowsPerStatement, 1000);
  assert.ok(args.out.endsWith("dist/subnet-snapshots-backfill.sql"));
});

test("parseArgs honors overrides", () => {
  const args = parseArgs([
    "--out",
    "/tmp/x.sql",
    "--d1-database",
    "some-db",
    "--page-size",
    "500",
    "--rows-per-statement",
    "200",
  ]);
  assert.deepEqual(args, {
    out: "/tmp/x.sql",
    database: "some-db",
    pageSize: 500,
    rowsPerStatement: 200,
  });
});

test("parseArgs rejects an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument/);
});

test("parseArgs rejects an out-of-range page size", () => {
  assert.throws(
    () => parseArgs(["--page-size", "0"]),
    /--page-size must be an integer/,
  );
  assert.throws(
    () => parseArgs(["--page-size", "5001"]),
    /--page-size must be an integer/,
  );
  assert.throws(
    () => parseArgs(["--page-size", "abc"]),
    /--page-size must be an integer/,
  );
});

test("parseArgs rejects a non-positive rows-per-statement", () => {
  assert.throws(
    () => parseArgs(["--rows-per-statement", "0"]),
    /--rows-per-statement must be a positive integer/,
  );
});

test("sqlLiteral renders NULL for null/undefined", () => {
  assert.equal(sqlLiteral("miner_count", null), "NULL");
  assert.equal(sqlLiteral("miner_count", undefined), "NULL");
});

test("sqlLiteral quotes a valid snapshot_date", () => {
  assert.equal(sqlLiteral("snapshot_date", "2025-06-23"), "'2025-06-23'");
});

test("sqlLiteral rejects a malformed snapshot_date", () => {
  assert.throws(
    () => sqlLiteral("snapshot_date", "06/23/2025"),
    /invalid snapshot_date/,
  );
  assert.throws(
    () => sqlLiteral("snapshot_date", 20250623),
    /invalid snapshot_date/,
  );
});

test("sqlLiteral renders integer columns verbatim and rejects non-integers", () => {
  assert.equal(sqlLiteral("netuid", 43), "43");
  assert.equal(sqlLiteral("captured_at", 1750643200000), "1750643200000");
  assert.throws(() => sqlLiteral("netuid", 43.5), /non-integer netuid/);
  assert.throws(() => sqlLiteral("netuid", "43"), /non-integer netuid/);
});

test("sqlLiteral renders real columns and rejects non-finite values", () => {
  assert.equal(sqlLiteral("alpha_price_tao", 0.789), "0.789");
  assert.equal(sqlLiteral("total_stake_tao", 100), "100");
  assert.throws(
    () => sqlLiteral("alpha_price_tao", NaN),
    /non-finite alpha_price_tao/,
  );
  assert.throws(
    () => sqlLiteral("alpha_price_tao", Infinity),
    /non-finite alpha_price_tao/,
  );
});

test("sqlLiteral rejects an unrecognized column", () => {
  assert.throws(
    () => sqlLiteral("not_a_real_column", 1),
    /unrecognized column/,
  );
});

test("rowTuple renders every column in declared order", () => {
  const tuple = rowTuple(SAMPLE_ROW);
  assert.equal(
    tuple,
    "(43, '2025-06-23', 80, 3, 2, 1, 0, 1750643200000, 64, 192, 123.456, 0.789, 0.0123, 26707.57, 2956464.98, 2257199.02, 798027.45)",
  );
});

test("rowTuple carries NULLs through for missing economics columns", () => {
  const tuple = rowTuple({
    ...SAMPLE_ROW,
    validator_count: null,
    miner_count: null,
    total_stake_tao: null,
    alpha_price_tao: null,
    emission_share: null,
  });
  assert.match(tuple, /NULL, NULL, NULL, NULL, NULL, 26707\.57/);
});

// #2552: pool liquidity + volume carry NULL through the same as the other
// economics columns when D1 has yet to backfill a snapshot row.
test("rowTuple carries NULLs through for missing pool liquidity + volume columns", () => {
  const tuple = rowTuple({
    ...SAMPLE_ROW,
    tao_in_pool_tao: null,
    alpha_in_pool: null,
    alpha_out_pool: null,
    subnet_volume_tao: null,
  });
  assert.match(tuple, /NULL, NULL, NULL, NULL\)$/);
});

test("chunkRows splits into fixed-size chunks with a final remainder", () => {
  const rows = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(chunkRows(rows, 3), [[0, 1, 2], [3, 4, 5], [6]]);
});

test("chunkRows now delegates to the shared lib.mjs implementation", () => {
  // The local reimplementation was removed in favor of the single canonical
  // helper; confirm the export the script exposes IS lib.mjs's chunkRows.
  assert.equal(chunkRows, sharedChunkRows);
});

test("chunkRows uses the shared 'always at least one chunk' semantics", () => {
  // The shared helper returns [[]] (never a bare []) for empty input -- this
  // is the one place the old local copy diverged, but it is unreachable here:
  // main() throws on zero rows before buildBackfillSql/chunkRows can run, so
  // every real (non-empty) input is chunked identically to before.
  assert.deepEqual(chunkRows([], 100), [[]]);
});

test("insertStatement emits an upsert that overwrites every non-key column", () => {
  const statement = insertStatement([SAMPLE_ROW]);
  assert.match(statement, /^INSERT INTO subnet_snapshots \(/);
  assert.match(
    statement,
    /ON CONFLICT \(netuid, snapshot_date\) DO UPDATE SET/,
  );
  // Every column except the two PK columns must appear in the SET clause,
  // as a straight excluded.<col> overwrite (D1 is authoritative on conflict).
  for (const column of [
    "completeness_score",
    "surface_count",
    "endpoint_count",
    "monitored_count",
    "candidate_count",
    "captured_at",
    "validator_count",
    "miner_count",
    "total_stake_tao",
    "alpha_price_tao",
    "emission_share",
    "tao_in_pool_tao",
    "alpha_in_pool",
    "alpha_out_pool",
    "subnet_volume_tao",
  ]) {
    assert.match(
      statement,
      new RegExp(`${column} = excluded\\.${column}`),
      `expected SET clause to overwrite ${column}`,
    );
  }
  assert.doesNotMatch(statement, /netuid = excluded\.netuid/);
  assert.doesNotMatch(statement, /snapshot_date = excluded\.snapshot_date/);
  assert.ok(statement.trim().endsWith(";"));
});

test("buildBackfillSql wraps batched statements in a single transaction", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    ...SAMPLE_ROW,
    netuid: i,
  }));
  const sql = buildBackfillSql(rows, 2);
  assert.match(
    sql,
    /^-- Generated by scripts\/backfill-subnet-snapshots-postgres\.mjs -- 5 rows, 3 statements\./,
  );
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /\nCOMMIT;\n$/);
  // 5 rows at 2/statement -> 3 INSERT statements.
  assert.equal((sql.match(/^INSERT INTO subnet_snapshots/gm) || []).length, 3);
});

function stubRunner(pages) {
  let call = 0;
  return () => {
    const page = pages[call] ?? [];
    call += 1;
    return { status: 0, stdout: JSON.stringify([{ results: page }]) };
  };
}

test("fetchPage parses a successful wrangler --json response", () => {
  const runner = stubRunner([[SAMPLE_ROW]]);
  const rows = fetchPage("metagraphed-health", 0, 3000, runner);
  assert.deepEqual(rows, [SAMPLE_ROW]);
});

test("fetchPage throws when the wrangler subprocess exits non-zero", () => {
  const runner = () => ({ status: 1, stdout: "", stderr: "boom" });
  assert.throws(
    () => fetchPage("metagraphed-health", 0, 3000, runner),
    /wrangler d1 execute failed.*boom/s,
  );
});

test("fetchPage throws on non-JSON stdout", () => {
  const runner = () => ({ status: 0, stdout: "not json" });
  assert.throws(
    () => fetchPage("metagraphed-health", 0, 3000, runner),
    /not valid JSON/,
  );
});

test("fetchPage throws on an unexpected JSON shape", () => {
  const runner = () => ({ status: 0, stdout: JSON.stringify([{}]) });
  assert.throws(
    () => fetchPage("metagraphed-health", 0, 3000, runner),
    /unexpected wrangler d1 output shape/,
  );
});

test("fetchAllRows pages until a short page ends the loop", async () => {
  const page1 = Array.from({ length: 3 }, (_, i) => ({
    ...SAMPLE_ROW,
    rowid: i + 1,
    netuid: i,
  }));
  const page2 = [{ ...SAMPLE_ROW, rowid: 4, netuid: 99 }]; // shorter than pageSize -> stop
  const runner = stubRunner([page1, page2]);
  const rows = await fetchAllRows("metagraphed-health", 3, runner);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.rowid),
    [1, 2, 3, 4],
  );
});

test("fetchAllRows stops immediately on an empty first page", async () => {
  const runner = stubRunner([[]]);
  const rows = await fetchAllRows("metagraphed-health", 100, runner);
  assert.deepEqual(rows, []);
});

test("fetchAllRows stops on an exact-pageSize page followed by empty", async () => {
  const page1 = Array.from({ length: 2 }, (_, i) => ({
    ...SAMPLE_ROW,
    rowid: i + 1,
    netuid: i,
  }));
  const runner = stubRunner([page1, []]);
  const rows = await fetchAllRows("metagraphed-health", 2, runner);
  assert.equal(rows.length, 2);
});
