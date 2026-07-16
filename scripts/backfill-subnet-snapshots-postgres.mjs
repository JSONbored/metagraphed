#!/usr/bin/env node
// One-time D1 -> Postgres BACKFILL for `subnet_snapshots` (D1-to-Postgres
// retirement effort, sibling to #4772's chain-data retirement). D1 has been
// the PRIMARY store for this table since AI-4 (src/health-prober.mjs's
// writeSubnetSnapshot, fired every hour): 47k+ rows back to 2025-06-23.
// Postgres only started receiving rows via syncSubnetSnapshotToPostgres's
// best-effort dual-write mirror once #4832 landed
// (workers/data-api.mjs's handleSubnetSnapshotSync), so it is missing over a
// year of history D1 already has -- exactly why METAGRAPH_SUBNET_SNAPSHOTS_SOURCE
// stays deliberately unflipped in wrangler.jsonc (see
// workers/request-handlers/analytics-routes.mjs's own header comment):
// flipping serving to Postgres before this backfill runs would truncate every
// trajectory/economics-trends chart down to the dual-write's short tail.
//
// This is a pure COPY, not a decode operation -- D1's values are already
// correct/final. The script pages the full D1 table (ordered by the table's
// implicit SQLite `rowid`, which is dense/gapless on this table, so paging
// never needs an expensive OFFSET re-scan) and emits ONE .sql file of batched
// `INSERT ... ON CONFLICT (netuid, snapshot_date) DO UPDATE SET <col> =
// excluded.<col>` statements wrapped in a single transaction. D1 is treated
// as authoritative on conflict, so re-applying this export always converges
// Postgres to match D1 exactly -- including for the ~258-row dual-write
// overlap window Postgres already had before the first run.
//
// There is no network path from this machine (or CI) directly to Postgres --
// it's reachable only via Hyperdrive from a deployed Worker, or via SSH to
// the indexer box. This script therefore only PAGES D1 and WRITES the .sql
// file; applying it is a separate, manual step (see below). Both steps are
// idempotent and safe to re-run: every row upserts on the table's real
// (netuid, snapshot_date) primary key, so re-running never duplicates
// anything, and a re-run after D1 has accrued more rows just picks up the
// delta.
//
// Usage:
//   node scripts/backfill-subnet-snapshots-postgres.mjs [--out <path>]
//     [--d1-database <name>] [--page-size <n>] [--rows-per-statement <n>]
//
// Apply the generated file against the indexer box's Postgres (never run
// migrations directly on prod -- copy in, then execute):
//   scp <out> <indexer-ssh-target>:/tmp/subnet-snapshots-backfill.sql
//   ssh <indexer-ssh-target> \
//     "sudo docker cp /tmp/subnet-snapshots-backfill.sql <postgres-container>:/tmp/x.sql && \
//      sudo docker exec <postgres-container> psql -U <postgres-user> -d <postgres-database> \
//        -v ON_ERROR_STOP=1 -f /tmp/x.sql"
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkRows, repoRoot } from "./lib.mjs";

// Column order matches Postgres's `subnet_snapshots` exactly (verified via
// `psql -c '\d subnet_snapshots'` against the live indexer instance), which
// in turn matches D1's own column order 1:1 -- this backfill was built
// specifically because the two schemas already agree, so no field mapping/
// renaming is needed, only a straight copy.
const COLUMNS = [
  "netuid",
  "snapshot_date",
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
];
const INTEGER_COLUMNS = new Set([
  "netuid",
  "completeness_score",
  "surface_count",
  "endpoint_count",
  "monitored_count",
  "candidate_count",
  "captured_at",
  "validator_count",
  "miner_count",
]);
const REAL_COLUMNS = new Set([
  "total_stake_tao",
  "alpha_price_tao",
  "emission_share",
  "tao_in_pool_tao",
  "alpha_in_pool",
  "alpha_out_pool",
  "subnet_volume_tao",
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPDATE_COLUMNS = COLUMNS.filter(
  (column) => column !== "netuid" && column !== "snapshot_date",
);

export function parseArgs(argv) {
  const out = {
    out: path.join(repoRoot, "dist/subnet-snapshots-backfill.sql"),
    database: "metagraphed-health",
    pageSize: 3000,
    rowsPerStatement: 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out.out = argv[++i];
    else if (arg === "--d1-database") out.database = argv[++i];
    else if (arg === "--page-size") out.pageSize = Number(argv[++i]);
    else if (arg === "--rows-per-statement")
      out.rowsPerStatement = Number(argv[++i]);
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  if (
    !Number.isInteger(out.pageSize) ||
    out.pageSize <= 0 ||
    out.pageSize > 5000
  ) {
    throw new Error("--page-size must be an integer in (0, 5000]");
  }
  if (!Number.isInteger(out.rowsPerStatement) || out.rowsPerStatement <= 0) {
    throw new Error("--rows-per-statement must be a positive integer");
  }
  return out;
}

// One page of `wrangler d1 execute --remote --json`, ordered by rowid so
// paging is a cheap indexed `WHERE rowid > ?` rather than an ever-more-costly
// `OFFSET`. `runner` is injection-only (tests stub it); production always
// uses the real `spawnSync` default below.
export function fetchPage(database, afterRowid, pageSize, runner = spawnSync) {
  const sql =
    `SELECT rowid, ${COLUMNS.join(", ")} FROM subnet_snapshots ` +
    `WHERE rowid > ${afterRowid} ORDER BY rowid LIMIT ${pageSize}`;
  const result = runner(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `wrangler d1 output was not valid JSON: ${String(result.stdout).slice(0, 500)}`,
    );
  }
  const rows = parsed?.[0]?.results;
  if (!Array.isArray(rows)) {
    throw new Error(
      `unexpected wrangler d1 output shape: ${String(result.stdout).slice(0, 500)}`,
    );
  }
  return rows;
}

export function sqlLiteral(column, value) {
  if (value === null || value === undefined) return "NULL";
  if (column === "snapshot_date") {
    if (typeof value !== "string" || !DATE_RE.test(value)) {
      throw new Error(
        `row has invalid snapshot_date: ${JSON.stringify(value)}`,
      );
    }
    return `'${value}'`;
  }
  if (INTEGER_COLUMNS.has(column)) {
    if (!Number.isInteger(value)) {
      throw new Error(
        `row has non-integer ${column}: ${JSON.stringify(value)}`,
      );
    }
    return String(value);
  }
  if (REAL_COLUMNS.has(column)) {
    if (!Number.isFinite(value)) {
      throw new Error(`row has non-finite ${column}: ${JSON.stringify(value)}`);
    }
    return String(value);
  }
  throw new Error(`unrecognized column: ${column}`);
}

export function rowTuple(row) {
  return `(${COLUMNS.map((column) => sqlLiteral(column, row[column])).join(", ")})`;
}

// Re-export the shared chunkRows from lib.mjs so existing importers keep a
// single, canonical implementation. This module used to carry its own copy
// that returned a bare [] for empty input, versus lib.mjs's "always at least
// one chunk" ([[]]); the two never diverge here because main() throws on zero
// rows before buildBackfillSql ever calls chunkRows.
export { chunkRows };

export function insertStatement(rows) {
  const values = rows.map(rowTuple).join(",\n  ");
  const setClause = UPDATE_COLUMNS.map(
    (column) => `${column} = excluded.${column}`,
  ).join(",\n    ");
  return (
    `INSERT INTO subnet_snapshots (${COLUMNS.join(", ")}) VALUES\n  ${values}\n` +
    `ON CONFLICT (netuid, snapshot_date) DO UPDATE SET\n    ${setClause};`
  );
}

export function buildBackfillSql(allRows, rowsPerStatement) {
  const statements = chunkRows(allRows, rowsPerStatement).map(insertStatement);
  return (
    `-- Generated by scripts/backfill-subnet-snapshots-postgres.mjs -- ` +
    `${allRows.length} rows, ${statements.length} statements.\n` +
    `-- Apply with: psql -v ON_ERROR_STOP=1 -f <this file>\n` +
    `BEGIN;\n\n${statements.join("\n\n")}\n\nCOMMIT;\n`
  );
}

export async function fetchAllRows(database, pageSize, runner = spawnSync) {
  const allRows = [];
  let afterRowid = 0;
  for (;;) {
    const page = fetchPage(database, afterRowid, pageSize, runner);
    if (!page.length) break;
    allRows.push(...page);
    afterRowid = page[page.length - 1].rowid;
    console.log(
      `  fetched ${allRows.length} rows so far (last rowid ${afterRowid})...`,
    );
    if (page.length < pageSize) break;
  }
  return allRows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Paging D1 database "${args.database}" (subnet_snapshots), page size ${args.pageSize}...`,
  );

  const allRows = await fetchAllRows(args.database, args.pageSize);
  if (!allRows.length) {
    throw new Error(
      "D1 returned zero rows for subnet_snapshots -- refusing to write an empty backfill",
    );
  }

  const sql = buildBackfillSql(allRows, args.rowsPerStatement);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, sql, "utf8");
  const statementCount = chunkRows(allRows, args.rowsPerStatement).length;
  console.log(
    `Wrote ${allRows.length} rows (${statementCount} statements) to ${args.out}`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  await main();
}
