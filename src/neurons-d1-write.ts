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
 * 100, because that is D1's limit for a query issued through the WORKERS
 * BINDING. This was 900, justified by a measurement that 1,200 parameters
 * "execute fine" against production D1 -- and they do, through
 * `wrangler d1 execute`, which goes over the HTTP API and has a different
 * ceiling. The binding does not, and the difference is invisible until a real
 * sync runs.
 *
 * The failure it caused was exact and reproducible: `POST
 * /api/v1/internal/neurons-sync` returned 502 `d1 write failed` for any
 * payload of 5+ rows, while 1-4 rows succeeded. neuron_daily is the widest
 * table at 22 columns, so 5 rows is 110 bound parameters -- the first chunk to
 * cross 100. Confirmed against production: 3 rows (66 params) and 4 rows (88)
 * return 200; 5 rows (110) returns 502. Every statement the writer emits
 * executes fine on its own via `wrangler d1 execute`, including all four in
 * one multi-statement transaction, which is why this looked like a batch or
 * schema problem rather than a per-query parameter cap.
 *
 * Keep the chunk size DERIVED from the column count: adding a column re-sizes
 * the chunk instead of silently pushing it over the limit. At 100 that is 5
 * rows per neurons statement, 4 per neuron_daily, 6 per account_position_daily.
 */
export const D1_PARAM_BUDGET = 100;

/**
 * Statements per `db.batch()` call.
 *
 * Matches src/observations-d1.ts's proven value. The 100-parameter cap above
 * means a full 30k-row snapshot is ~18,700 statements, and one `batch()` of
 * that size is its own failure mode -- so the batch is chunked too.
 */
export const D1_STATEMENTS_PER_BATCH = 50;

export function rowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(D1_PARAM_BUDGET / Math.max(1, columnCount)));
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
}
interface D1Like {
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

function chunkStatements(
  db: D1Like,
  table: string,
  columns: string[],
  conflict: string[],
  rows: Row[],
): D1PreparedStatement[] {
  const perStatement = rowsPerStatement(columns.length);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const sql = buildUpsert(table, columns, conflict, chunk.length);
    const values = chunk.flatMap((row) =>
      columns.map((column) => row[column] ?? null),
    );
    statements.push(db.prepare(sql).bind(...values));
  }
  return statements;
}

export interface NeuronSnapshotWrite {
  rows: Row[];
  dailyRows: Row[];
  positionRows: Row[];
  /** Per-netuid max captured_at -- NOT one batch-wide value. */
  netuidMaxCapturedAt: Map<number, number>;
}

/**
 * Write one sync batch to D1, atomically.
 *
 * Statements are ordered upserts-first, prune-last, and runBatches preserves
 * that. A single `db.batch()` would be one implicit transaction -- what the
 * Postgres side gets from `sql.begin()` -- but D1's 100-parameter-per-query
 * cap makes a full snapshot ~18,700 statements, far past what one batch
 * carries. See runBatches for why the ordering makes chunking safe: a failure
 * part-way leaves stale rows the next tick prunes, never live UIDs deleted
 * with nothing to replace them.
 *
 * The prune is per-netuid for the same reason it is on the Postgres side -- a
 * batch-wide max captured_at would let one netuid's later capture delete rows
 * this very request just wrote for a different, earlier-captured netuid.
 */
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

  await runBatches(db, statements);
  return { statements: statements.length };
}

/**
 * Run `statements` as a sequence of bounded `db.batch()` calls.
 *
 * ATOMICITY, HONESTLY. One `batch()` is one implicit transaction; several are
 * not. At D1_PARAM_BUDGET=100 a full snapshot is ~18,700 statements, which a
 * single batch will not carry, so the choice is between chunked batches and a
 * write that does not work at all.
 *
 * The ordering is what makes chunking safe: callers append every upsert BEFORE
 * any prune, and this preserves that order. A failure part-way therefore
 * leaves some rows refreshed and the prune un-run -- stale rows survive that
 * the next tick removes. The inverse (prune first, then fail) would delete
 * live UIDs and leave nothing to replace them, which is why the order is a
 * contract and not an accident.
 */
async function runBatches(
  db: D1Like,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let i = 0; i < statements.length; i += D1_STATEMENTS_PER_BATCH) {
    const chunk = statements.slice(i, i + D1_STATEMENTS_PER_BATCH);
    if (chunk.length) await db.batch(chunk);
  }
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
  await runBatches(db, statements);
  return { statements: statements.length };
}
