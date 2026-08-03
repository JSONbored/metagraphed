// The chain-detail hot-tier write path (#9208): validation + the D1 statements
// for one live-follow decode batch.
//
// The producer (metagraphed-infra's poller lane) follows the FINALIZED head,
// decodes each block with the same shared decoder the hourly R2 batch lane
// uses, and POSTs batches of 2 blocks to
// POST /api/v1/internal/chain-detail-sync. Measured payloads carry 11-143
// extrinsics, 217-667 chain_events and 146-461 account_events per block, so a
// request is ~800-3,000 rows and 350-662 KiB.
//
// THE BINDING'S PARAMETER LIMIT IS THE WHOLE REASON THIS MODULE EXISTS in the
// shape it does. The Workers D1 binding enforces 100 bound parameters per
// statement (the wrangler/HTTP path allows 1,200 -- two different limits, and
// only the binding's matters because the binding is what this runs on; #9157
// found that the hard way, with fifteen consecutive production syncs failing
// before a single row landed). So the budget arithmetic, the chunking and the
// slicing are reused verbatim from src/neurons-d1-write.ts rather than
// re-derived: D1_PARAM_BUDGET, rowsPerStatement and batchInSlices are imported,
// and the chunk size stays DERIVED from each table's column count so adding a
// column re-sizes the batch instead of silently pushing it over the limit.
//
// The one thing NOT reused is buildUpsert, and only because of its trailing
// `captured_at <= excluded.captured_at` staleness guard. These rows have no
// captured_at: they describe a FINALIZED block, whose decode is deterministic,
// so "newer" is not a meaningful comparison and a re-POST is a no-op by
// construction rather than by comparison. The producer prefers re-sending over
// skipping, so the upsert has to be safe -- it is, on the natural key -- but it
// must not silently drop a rewrite because a timestamp went backwards.
//
// NOTHING IS TRANSFORMED HERE. call_args/args go to D1 as the producer sent
// them: the raw scale_value enum tree, JSON-encoded, as TEXT. The serve-time
// normalizers (src/scale-normalize.ts, src/postgres-call-args.ts,
// src/chain-event-args.ts) run on read for every tier, so a hot row and a cold
// row of the same extrinsic decode identically. Pre-transforming on write would
// be a second, drifting decoder.

import {
  D1_PARAM_BUDGET,
  batchInSlices,
  rowsPerStatement,
  type D1Like,
  type D1PreparedStatement,
} from "./neurons-d1-write.ts";

export { D1_PARAM_BUDGET, batchInSlices, rowsPerStatement };
export type { D1Like, D1PreparedStatement };

type Row = Record<string, unknown>;

/** Columns of `chain_detail_blocks` -- the coverage register. */
export const CHAIN_DETAIL_BLOCK_COLUMNS = [
  "block_number",
  "block_hash",
  "spec_version",
  "extrinsic_count",
  "chain_event_count",
  "account_event_count",
  "observed_at",
  "synced_at",
];

/** Columns of `chain_detail_extrinsics`. */
export const CHAIN_DETAIL_EXTRINSIC_COLUMNS = [
  "block_number",
  "extrinsic_index",
  "extrinsic_hash",
  "signer",
  "call_module",
  "call_function",
  "success",
  "fee_tao",
  "tip_tao",
  "call_args",
  "observed_at",
];

/** Columns of `chain_detail_chain_events`. */
export const CHAIN_DETAIL_CHAIN_EVENT_COLUMNS = [
  "block_number",
  "event_index",
  "pallet",
  "method",
  "args",
  "phase",
  "extrinsic_index",
  "observed_at",
];

/** Columns of `chain_detail_account_events`. */
export const CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS = [
  "block_number",
  "event_index",
  "extrinsic_index",
  "event_kind",
  "hotkey",
  "coldkey",
  "netuid",
  "uid",
  "amount_tao",
  "alpha_amount",
  "observed_at",
];

/** The natural key of each table, in the order the PRIMARY KEY declares it. */
export const CHAIN_DETAIL_CONFLICT_KEYS = {
  chain_detail_blocks: ["block_number"],
  chain_detail_extrinsics: ["block_number", "extrinsic_index"],
  chain_detail_chain_events: ["block_number", "event_index"],
  chain_detail_account_events: ["block_number", "event_index"],
} as const;

/** The three SCALE phase variants an event can carry. A value outside this set
 * is a decoder the Worker does not understand, so the row is rejected rather
 * than stored as an unqueryable string. */
export const CHAIN_EVENT_PHASES = new Set([
  "ApplyExtrinsic",
  "Finalization",
  "Initialization",
]);

/**
 * A multi-row INSERT ... ON CONFLICT DO UPDATE on the natural key, with every
 * non-key column refreshed from the incoming row and NO staleness guard.
 *
 * See this module's header for why the guard is absent rather than forgotten.
 */
export function buildChainDetailUpsert(
  table: string,
  columns: string[],
  conflict: readonly string[],
  rowCount: number,
): string {
  const updatable = columns.filter((column) => !conflict.includes(column));
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ` +
    `${Array.from({ length: rowCount }, () => tuple).join(", ")} ` +
    `ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ` +
    updatable.map((column) => `${column} = excluded.${column}`).join(", ")
  );
}

/** Rows -> prepared statements, chunked under the binding's parameter budget. */
export function chunkChainDetailStatements(
  db: D1Like,
  table: keyof typeof CHAIN_DETAIL_CONFLICT_KEYS,
  columns: string[],
  rows: Row[],
): D1PreparedStatement[] {
  const conflict = CHAIN_DETAIL_CONFLICT_KEYS[table];
  const perStatement = rowsPerStatement(columns.length);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const sql = buildChainDetailUpsert(table, columns, conflict, chunk.length);
    const values = chunk.flatMap((row) =>
      columns.map((column) => row[column] ?? null),
    );
    statements.push(db.prepare(sql).bind(...values));
  }
  return statements;
}

export interface ChainDetailWrite {
  blockRows: Row[];
  extrinsicRows: Row[];
  chainEventRows: Row[];
  accountEventRows: Row[];
}

/**
 * Write one sync batch to D1.
 *
 * ORDER IS LOAD-BEARING: the coverage register (`chain_detail_blocks`) is
 * written LAST. A row there is the claim "this block's detail is queryable",
 * and `answerBlockDetail` treats a present block row as authoritative --
 * including when it answers with an empty list. Writing it first would open a
 * window in which a block advertises coverage it does not yet have, and every
 * read in that window would report a measured zero for rows that are merely
 * still in flight. Writing it last means the worst case is the opposite and
 * harmless one: rows present, not yet advertised, read as "not covered" and
 * decline until the next slice lands.
 */
export async function writeChainDetailToD1(
  db: D1Like,
  {
    blockRows,
    extrinsicRows,
    chainEventRows,
    accountEventRows,
  }: ChainDetailWrite,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = [
    ...chunkChainDetailStatements(
      db,
      "chain_detail_extrinsics",
      CHAIN_DETAIL_EXTRINSIC_COLUMNS,
      extrinsicRows,
    ),
    ...chunkChainDetailStatements(
      db,
      "chain_detail_chain_events",
      CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
      chainEventRows,
    ),
    ...chunkChainDetailStatements(
      db,
      "chain_detail_account_events",
      CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
      accountEventRows,
    ),
    ...chunkChainDetailStatements(
      db,
      "chain_detail_blocks",
      CHAIN_DETAIL_BLOCK_COLUMNS,
      blockRows,
    ),
  ];
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
