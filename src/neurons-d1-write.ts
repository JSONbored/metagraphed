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

async function batchInSlices(
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
