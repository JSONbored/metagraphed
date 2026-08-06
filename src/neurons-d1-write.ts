// The neurons-sync write path, against D1 (#9146 priority 1).
//
// The neurons family is the only LIVE-refreshed data left on the decommissioned
// box: a sync posts chain state every refresh. The lakehouse holds its history,
// but history is frozen -- once the box goes, the sync has nowhere to write and
// the metagraph stops advancing. This is the D1 half of that write path.
//
// Statements are built here rather than with postgres.js's `sql(chunk, ...cols)`
// helper because D1 has no equivalent, but the SHAPE is deliberately identical
// to the Postgres side: the same upsert keys, the same
// `captured_at <= excluded.captured_at` staleness guard, and the same per-netuid
// prune. SQLite supports `excluded.` and a WHERE clause on DO UPDATE, so the
// two paths agree line for line rather than merely in spirit.
import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";

/** Columns of `neuron_daily` = the neuron row plus its day and write stamp. */
export const NEURON_DAILY_COLUMNS = [
  ...NEURON_INSERT_COLUMNS,
  "snapshot_date",
  "updated_at",
];

/** Columns of `account_position_daily` -- the same snapshot re-keyed by account. */
export const ACCOUNT_POSITION_DAILY_COLUMNS = [
  "account",
  "netuid",
  "snapshot_date",
  "uid",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "incentive",
  "dividends",
  "stake_tao",
  "emission_tao",
  "captured_at",
  "updated_at",
];

/**
 * Bound-parameter budget per statement.
 *
 * CORRECTED against production, the hard way: the original 900 budget was
 * "measured" through the wrangler/HTTP path, where 1,200 bound parameters do
 * execute -- but the WORKERS-RUNTIME BINDING enforces 100 bound parameters
 * per statement, and every one of the first 15 production syncs failed with
 * "D1_ERROR: too many SQL variables" before a single row landed. The two
 * paths have different limits; only the binding's limit matters here because
 * the binding is what this code runs on. 90 leaves margin under 100, and the
 * chunk size stays DERIVED from the column count, so adding a column
 * re-sizes the batch instead of silently pushing it over the limit again.
 */
export const D1_PARAM_BUDGET = 90;

export function rowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(D1_PARAM_BUDGET / Math.max(1, columnCount)));
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
}
export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

type Row = Record<string, unknown>;

/**
 * A multi-row INSERT ... ON CONFLICT DO UPDATE for one chunk.
 *
 * `conflict` is the upsert key; every non-key column is refreshed from the
 * incoming row. The trailing staleness guard is what makes a replayed or
 * out-of-order batch a no-op instead of a regression: an older capture must
 * never overwrite a newer one.
 */
export function buildUpsert(
  table: string,
  columns: string[],
  conflict: string[],
  rowCount: number,
): string {
  const updatable = columns.filter((column) => !conflict.includes(column));
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ` +
    `${Array.from({ length: rowCount }, () => tuple).join(", ")} ` +
    `ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ` +
    updatable.map((column) => `${column} = excluded.${column}`).join(", ") +
    ` WHERE ${table}.captured_at <= excluded.captured_at`
  );
}

/**
 * A plain multi-row INSERT for an append-only table (the history tables have
 * no conflict target -- their only key is the AUTOINCREMENT id, mirroring the
 * Postgres BIGSERIAL -- so an upsert clause there would be a lie about their
 * write semantics).
 */
export function buildAppendInsert(
  table: string,
  columns: string[],
  rowCount: number,
): string {
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ` +
    Array.from({ length: rowCount }, () => tuple).join(", ")
  );
}

/**
 * THE ROW-PER-PARAMETER SHAPE IS WHY THESE LANES KEPT TIMING OUT (#9543).
 *
 * A statement built by buildUpsert spends one bound parameter per COLUMN per
 * ROW, so the 90-parameter budget above puts 22 rows in a 4-column statement
 * and 6 in a 15-column one. A full pass is then tens of thousands of
 * statements -- ~16,000 for a 30k-neuron snapshot, ~14,600 for a 364k-row
 * account-balances pass -- and the producer's HTTP request carrying them has
 * 60 seconds to finish. It did not: account-balances published 48% of a pass,
 * and metagraphed-infra#325 responded by shrinking the chunk, which moved the
 * failure from request 8 to request 29 rather than removing it.
 *
 * The parameter budget is not a law about how many ROWS fit in a statement. It
 * is a law about how many PARAMETERS do, and a whole chunk fits in ONE if it
 * travels as JSON:
 *
 *   INSERT INTO t (a, b) SELECT json_extract(value, '$[0]'), ...
 *   FROM json_each(?1) WHERE true ON CONFLICT ... DO UPDATE SET ...
 *
 * Same upsert, same `captured_at <= excluded.captured_at` guard, one statement
 * per chunk instead of hundreds. Verified against production D1 (SQLite's JSON1
 * is enabled there, `ON CONFLICT` parses after a SELECT given the `WHERE true`,
 * and a replayed older capture is still refused by the guard).
 *
 * ROWS TRAVEL AS POSITIONAL ARRAYS, not objects: `[[v,v],[v,v]]` rather than
 * `[{"a":v},{"a":v}]`. The column names are already in the statement, so
 * repeating them per row would inflate the payload for nothing -- and the
 * payload is what this chunking is now bounded by.
 *
 * `WHERE true` is load-bearing rather than decorative: without it SQLite parses
 * the `ON CONFLICT` as part of the SELECT's source and the statement fails.
 */
export function buildJsonUpsert(
  table: string,
  columns: string[],
  conflict: string[],
  /**
   * An optional SQL predicate on the incoming row, evaluated INSIDE the
   * statement so a rejected row costs no D1 write at all.
   *
   * This is how a lane declines to store rows nothing will ever read. Filtering
   * in the Worker instead would still pay the write; filtering in the producer
   * would need it to know something only the database does. The predicate may
   * reference `json_extract(value, '$[i]')` for the incoming row's columns.
   */
  filter?: string,
): string {
  const updatable = columns.filter((column) => !conflict.includes(column));
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) SELECT ` +
    columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ") +
    ` FROM json_each(?1) WHERE true` +
    (filter ? ` AND (${filter})` : "") +
    ` ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ` +
    updatable.map((column) => `${column} = excluded.${column}`).join(", ") +
    ` WHERE ${table}.captured_at <= excluded.captured_at`
  );
}

/** The append-only twin, for tables whose only key is their AUTOINCREMENT id
 * -- an upsert clause there would be a lie about their write semantics. */
export function buildJsonAppendInsert(
  table: string,
  columns: string[],
): string {
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) SELECT ` +
    columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ") +
    ` FROM json_each(?1)`
  );
}

/**
 * Bytes of serialized JSON per statement.
 *
 * The bound-parameter COUNT stops being the constraint once a chunk travels as
 * one parameter; its SIZE becomes the constraint instead. And the size limit on
 * a bound parameter is the one number here that is NOT documented and could NOT
 * be measured: `wrangler dev --remote` crashes on this Worker before a request
 * completes, and `wrangler dev` locally refuses to boot it at all
 * (`REALIZED_RETURN_BASELINE_TOLERANCE_DAYS` is rejected by workerd, unrelated
 * to this path). Both failures are in the tooling, not in the write.
 *
 * MEASURING IT THROUGH `wrangler d1 execute` WOULD BE WORSE THAN NOT MEASURING,
 * and D1_PARAM_BUDGET's own comment above is why: 1,200 bound parameters
 * execute happily over that HTTP path while the Workers runtime binding
 * enforces 100, and fifteen production syncs failed before anyone noticed the
 * two paths have different limits. A number confirmed on the wrong path reads
 * exactly like a number confirmed on the right one.
 *
 * So this is set from what IS documented rather than from an experiment that
 * cannot be run: D1's maximum SQL statement length is 100 KB, and 64 KB sits
 * under it with room for the statement text and encoding overhead. That is
 * conservative on purpose. At four short columns it is ~1,400 rows a statement
 * against the 22 the parameter budget allowed, so a 364k-row pass falls from
 * ~14,600 statements to ~260 -- the overwhelming majority of the available win,
 * with none of the risk of sitting on an unverified ceiling. Sitting on a
 * ceiling is what #325 was already cleaning up after.
 *
 * RAISING THIS IS FINE, but only against a measurement taken through a real
 * binding -- a deployed Worker or a working `--remote` session -- never through
 * the CLI.
 */
export const D1_JSON_BUDGET_BYTES = 64_000;

/**
 * Rows -> chunks, split so each chunk's serialized JSON stays under the byte
 * budget. A single row over budget still gets its own chunk: dropping it would
 * lose data, and D1 rejecting one oversized statement is a loud failure rather
 * than a silent gap.
 */
export function chunkRowsByJsonBytes(
  rows: Row[],
  columns: string[],
  budgetBytes: number = D1_JSON_BUDGET_BYTES,
): unknown[][][] {
  const chunks: unknown[][][] = [];
  let current: unknown[][] = [];
  let bytes = 2; // the enclosing []
  for (const row of rows) {
    const tuple = columns.map((column) => row[column] ?? null);
    const size = JSON.stringify(tuple).length + 1; // + the joining comma
    if (current.length && bytes + size > budgetBytes) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(tuple);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Rows -> prepared statements, one statement per chunk. An empty `conflict`
 * means the table is append-only; a non-empty one is the upsert key. Shared by
 * this module and src/hyperparams-identity-d1-write.ts so there is exactly one
 * place the chunking and the column-order binding live.
 */
export function chunkStatements(
  db: D1Like,
  table: string,
  columns: string[],
  conflict: string[],
  rows: Row[],
  /** See buildJsonUpsert's own `filter`. Upsert-only: an append-only table has
   * no key to decline a row against. */
  filter?: string,
): D1PreparedStatement[] {
  const sql = conflict.length
    ? buildJsonUpsert(table, columns, conflict, filter)
    : buildJsonAppendInsert(table, columns);
  return chunkRowsByJsonBytes(rows, columns).map((chunk) =>
    db.prepare(sql).bind(JSON.stringify(chunk)),
  );
}

export interface NeuronSnapshotWrite {
  rows: Row[];
  dailyRows: Row[];
  positionRows: Row[];
  /** Per-netuid max captured_at -- NOT one batch-wide value. */
  netuidMaxCapturedAt: Map<number, number>;
}

// --- The three derivations, pure and shared ---------------------------------
//
// `neuron_daily` and `account_position_daily` are pure functions of the posted
// rows, and the prune cutoff is a pure function of them too. They used to be
// computed inline in the sync handler, which was fine while the handler was the
// only writer. It is not any more: the queue consumer receives a message that
// carries `rows` and nothing else (metagraphed-infra#359 is the standing reason
// SyncBatchMessage stays one array), so it has to redo all three.
//
// Two implementations of a prune cutoff is two chances to compute a different
// one, and the failure mode there is deleted rows. So there is one.

/**
 * Per-netuid max `captured_at`, the cutoff `writeNeuronSnapshotToD1` prunes on.
 *
 * NOT one batch-wide value: a global max would let one netuid's later capture
 * delete rows this same write just upserted for a different, earlier-captured
 * netuid -- its own fresh rows would satisfy `captured_at < max`.
 *
 * Rows with an unusable netuid or captured_at are skipped rather than seeding a
 * NaN cutoff, which would delete every row for that netuid. Same rule, and the
 * same reason, as `coldkeyMaxCapturedAt` in the positions lane.
 */
export function netuidMaxCapturedAt(rows: Row[]): Map<number, number> {
  const cutoffs = new Map<number, number>();
  for (const row of rows) {
    const netuid = row?.netuid;
    const capturedAt = row?.captured_at;
    if (!Number.isFinite(netuid as number)) continue;
    if (!Number.isFinite(capturedAt as number)) continue;
    const current = cutoffs.get(netuid as number);
    if (current == null || (capturedAt as number) > current) {
      cutoffs.set(netuid as number, capturedAt as number);
    }
  }
  return cutoffs;
}

/** The UTC day a capture belongs to, matching D1's `rollupNeuronDaily`
 * (`date(captured_at / 1000, 'unixepoch')`). */
export function neuronSnapshotDate(capturedAtMs: number): string {
  return new Date(capturedAtMs).toISOString().slice(0, 10);
}

/** `neuron_daily` rows: the posted row plus its day and a write stamp. */
export function neuronDailyRows(rows: Row[], nowMs: number): Row[] {
  return rows.map((row) => ({
    ...row,
    snapshot_date: neuronSnapshotDate(row.captured_at as number),
    updated_at: nowMs,
  }));
}

/**
 * `account_position_daily` rows, re-keyed by account.
 *
 * Rows with no hotkey are dropped: the table is keyed on `account`, so a null
 * one has nowhere to go.
 */
export function neuronPositionRows(dailyRows: Row[]): Row[] {
  return dailyRows
    .filter((row) => row.hotkey != null)
    .map((row) => ({
      account: row.hotkey,
      netuid: row.netuid,
      snapshot_date: row.snapshot_date,
      uid: row.uid,
      coldkey: row.coldkey,
      active: row.active,
      validator_permit: row.validator_permit,
      rank: row.rank,
      trust: row.trust,
      incentive: row.incentive,
      dividends: row.dividends,
      stake_tao: row.stake_tao,
      emission_tao: row.emission_tao,
      captured_at: row.captured_at,
      updated_at: row.updated_at,
    }));
}

/** Everything `writeNeuronSnapshotToD1` needs, derived from the rows alone --
 * so the sync handler and the queue consumer build it the same way. */
export function neuronSnapshotWrite(
  rows: Row[],
  nowMs: number,
): NeuronSnapshotWrite {
  const dailyRows = neuronDailyRows(rows, nowMs);
  return {
    rows,
    dailyRows,
    positionRows: neuronPositionRows(dailyRows),
    netuidMaxCapturedAt: netuidMaxCapturedAt(rows),
  };
}

/**
 * Write one sync batch to D1, atomically.
 *
 * `db.batch()` runs its statements in a single implicit transaction, which is
 * what the Postgres side gets from `sql.begin()`. That matters for the prune:
 * a mid-batch failure must never leave `neurons` upserted with stale UIDs left
 * un-pruned.
 *
 * The prune is per-netuid for the same reason it is on the Postgres side -- a
 * batch-wide max captured_at would let one netuid's later capture delete rows
 * this very request just wrote for a different, earlier-captured netuid.
 */
/**
 * db.batch in slices. One giant batch was the original design (single
 * implicit transaction, all-or-nothing), but the 90-param budget puts a full
 * 30k-neuron snapshot at ~16,000 statements, which is its own way to find a
 * platform ceiling. Slices of 1,000 keep each call far from any limit.
 *
 * The trade, stated honestly: atomicity is now per-slice. Statement ORDER is
 * preserved and the prunes are appended last, so the failure mode of a
 * mid-run slice is "fresh rows landed, prune not yet run" -- stale UIDs
 * linger until the next 15-minute tick, which is the same staleness the old
 * all-or-nothing failure produced (nothing landed at all), with strictly
 * more fresh data. No failure mode reorders a prune ahead of its upserts.
 */
const BATCH_SLICE = 1_000;

export async function batchInSlices(
  db: D1Like,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SLICE) {
    await db.batch(statements.slice(i, i + BATCH_SLICE));
  }
}

export async function writeNeuronSnapshotToD1(
  db: D1Like,
  { rows, dailyRows, positionRows, netuidMaxCapturedAt }: NeuronSnapshotWrite,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = [
    ...chunkStatements(
      db,
      "neurons",
      NEURON_INSERT_COLUMNS,
      ["netuid", "uid"],
      rows,
    ),
    ...chunkStatements(
      db,
      "neuron_daily",
      NEURON_DAILY_COLUMNS,
      ["netuid", "uid", "snapshot_date"],
      dailyRows,
    ),
    ...chunkStatements(
      db,
      "account_position_daily",
      ACCOUNT_POSITION_DAILY_COLUMNS,
      ["account", "netuid", "snapshot_date"],
      positionRows,
    ),
  ];

  for (const [netuid, capturedAt] of netuidMaxCapturedAt) {
    statements.push(
      db
        .prepare("DELETE FROM neurons WHERE netuid = ? AND captured_at < ?")
        .bind(netuid, capturedAt),
    );
  }

  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}

/**
 * Write one historical backfill batch to D1, atomically.
 *
 * The daily-history half of writeNeuronSnapshotToD1 and nothing else:
 * a backfill walks PAST snapshot_dates, so it must NEVER touch `neurons`
 * (latest-only) or run the prune -- handleNeuronDailyBackfill's own header
 * explains why that invariant exists, and it is store-independent. The same
 * captured_at staleness guard makes an overlapping or replayed backfill a
 * no-op rather than a regression.
 */
export async function writeNeuronDailyBackfillToD1(
  db: D1Like,
  {
    dailyRows,
    positionRows,
  }: Pick<NeuronSnapshotWrite, "dailyRows" | "positionRows">,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = [
    ...chunkStatements(
      db,
      "neuron_daily",
      NEURON_DAILY_COLUMNS,
      ["netuid", "uid", "snapshot_date"],
      dailyRows,
    ),
    ...chunkStatements(
      db,
      "account_position_daily",
      ACCOUNT_POSITION_DAILY_COLUMNS,
      ["account", "netuid", "snapshot_date"],
      positionRows,
    ),
  ];
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
