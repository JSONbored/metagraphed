// Writing HISTORICAL subnet_hyperparams_history rows (#5597).
//
// ## Why the live sync path cannot do this
//
// `handleSubnetHyperparamsSync` is a forward-only writer and correct as such,
// but two of its properties make it unusable for a replay:
//
//   1. `const now = Date.now()` -- it stamps `observed_at` server-side. The
//      payload carries `block_number` but not `observed_at`, so ~3,697
//      historical rows would all land on one instant and collide on the
//      `(netuid, observed_at)` conflict key.
//   2. It diffs each incoming row against the LATEST recorded hash and appends
//      only on change. Right for a lane reading the head; wrong for a replay,
//      where a row must be diffed against its own predecessor in time, not
//      against today.
//
// So this module takes `observed_at` from the caller (the BLOCK's timestamp)
// and does not diff at all: the historical sequence IS the diff. The producer
// already knows which blocks changed -- it read them out of the lakehouse's
// AdminUtils extrinsics -- so re-deriving "did this change" here would be
// asking a question that is already answered.
//
// ## Same rows as the live lane, deliberately
//
// The hash comes from `hyperparamsHash` and the column list from
// `SUBNET_HYPERPARAMS_HISTORY_COLUMNS`, both shared with the live writer, so a
// backfilled row is indistinguishable from one the hourly lane appended. That
// is the whole requirement: `/subnets/{netuid}/hyperparameters/history` serves
// both from one table and must not be able to tell them apart.
//
// ## Idempotency
//
// `ON CONFLICT (netuid, observed_at) DO NOTHING`. Migration 0003 records that
// the natural key is unique and is "what the mirror and the backfill conflict
// on" -- this is that backfill. Re-running is free, and the live lane can keep
// writing while it runs.
import { hyperparamsHash } from "./subnet-hyperparams-history.ts";
import { formatSubnetHyperparams } from "./subnet-hyperparams.ts";
import { SUBNET_HYPERPARAMS_HISTORY_COLUMNS } from "./hyperparams-identity-neon-write.ts";

export const HYPERPARAMS_BACKFILL_LANE = "subnet-hyperparams-backfill";

/**
 * The epoch-milliseconds floor migration 0010 puts on every dated table.
 *
 * 1e12 is 2001-09-09; a seconds-valued stamp this decade is ~1.79e9, three
 * digits short. #9782 is what this prevents -- a stamp missing those digits
 * produced a row dated 1970 that no later pass could revise, in an append-only
 * table exactly like this one. A backfill is the likeliest place to reintroduce
 * it, because the producer is converting block timestamps rather than calling
 * Date.now().
 */
export const EPOCH_MS_FLOOR = 1e12;

export interface HistoricalHyperparamsRow {
  netuid: number;
  /** The block the change was observed at. Never null here: the producer found
   * this row BY its block, so a null would mean it lost track of which. */
  block_number: number;
  /** The BLOCK's timestamp in epoch milliseconds -- not the time of the run. */
  observed_at: number;
  /** The decoded 33-field object, in the shape the live sync path posts. */
  hyperparameters: Record<string, unknown>;
}

export interface BackfillWriteResult {
  /** Rows the statement accepted. Not the same as rows INSERTED: a conflict is
   * silently skipped, which is the point. */
  attempted: number;
  rejected: { netuid: number; reason: string }[];
}

/** Rows that cannot be written, with the reason -- never silently dropped. */
export function rejectRow(row: HistoricalHyperparamsRow): string | null {
  if (!Number.isInteger(row?.netuid) || row.netuid < 0) return "netuid";
  if (!Number.isSafeInteger(row?.block_number) || row.block_number <= 0) {
    return "block_number";
  }
  if (!Number.isSafeInteger(row?.observed_at)) return "observed_at";
  // A seconds-valued stamp is the failure this floor exists for, and it is
  // silent without the check: the row inserts fine and dates to 1970.
  if (row.observed_at < EPOCH_MS_FLOOR) return "observed_at_not_millis";
  if (!row.hyperparameters || typeof row.hyperparameters !== "object") {
    return "hyperparameters";
  }
  return null;
}

interface SqlRunner {
  unsafe(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Append a batch of historical revisions.
 *
 * Returns what it attempted and what it refused, rather than throwing on a bad
 * row: one malformed entry in a 3,697-row replay should cost that entry, not
 * the run -- but it must be REPORTED, because a backfill that silently drops
 * rows is indistinguishable from one that worked.
 */
export async function writeHistoricalHyperparams(
  sql: SqlRunner,
  rows: readonly HistoricalHyperparamsRow[],
): Promise<BackfillWriteResult> {
  const rejected: { netuid: number; reason: string }[] = [];
  let attempted = 0;

  // The history columns minus the three keying ones, in the order the shared
  // constant declares them -- so a column added to the family lands here
  // without this module naming any of the 33 fields itself.
  const fieldColumns = SUBNET_HYPERPARAMS_HISTORY_COLUMNS.filter(
    (c) => c !== "netuid" && c !== "block_number" && c !== "observed_at",
  );
  const columns = ["netuid", "block_number", "observed_at", ...fieldColumns];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const statement =
    `INSERT INTO subnet_hyperparams_history (${columns.join(", ")}) ` +
    `VALUES (${placeholders}) ` +
    `ON CONFLICT (netuid, observed_at) DO NOTHING`;

  for (const row of rows) {
    const reason = rejectRow(row);
    if (reason) {
      rejected.push({ netuid: row?.netuid, reason });
      continue;
    }
    // The SAME formatter and hash the live path uses, so the two writers cannot
    // produce different bytes for the same chain state.
    const hyperparameters = formatSubnetHyperparams(row.hyperparameters) as
      Record<string, unknown> | null | undefined;
    if (!hyperparameters) {
      rejected.push({ netuid: row.netuid, reason: "unformattable" });
      continue;
    }
    const hash = await hyperparamsHash(hyperparameters);
    const values = [
      row.netuid,
      row.block_number,
      row.observed_at,
      ...fieldColumns.map((column) =>
        column === "hyperparams_hash"
          ? hash
          : ((hyperparameters as Record<string, unknown>)[column] ?? null),
      ),
    ];
    await sql.unsafe(statement, values);
    attempted += 1;
  }

  return { attempted, rejected };
}
