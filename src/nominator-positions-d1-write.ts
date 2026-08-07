// The nominator-positions sync write path, against D1 (#9273).
//
// This lane had no live writer at all: `nominator_positions` was populated by
// a job on the decommissioned box, and once that box went away the ledger
// froze at its export. The route over it kept answering -- with a stamp that
// can never advance and, for anyone who started delegating after the export, a
// confident `positions: 0`. This module is the D1 half of the revived write
// path, and it deliberately reuses src/neurons-d1-write.ts's statement
// building rather than restating it: one place owns the bound-parameter
// arithmetic (the WORKERS-BINDING limit of 100 per statement, not the 1,200
// `wrangler d1 execute` permits) and the batch slicing.
//
// SHAPE MIRRORS THE NEURONS LANE, not the hyperparams one, and the difference
// is the prune. A hyperparams batch covers every active subnet in one request,
// so its prune is a plain "not in this batch" sweep. A full Alpha scan is
// ~153,611 rows -- far past any single request body -- so this lane posts in
// several requests and a batch-wide sweep would let one request delete the
// rows another just wrote. The prune is therefore PER COLDKEY against that
// coldkey's own max captured_at, the exact analogue of neurons-sync's
// per-netuid prune, and it rests on the same poster contract: one coldkey's
// positions are never split across two requests.
import {
  batchInSlices,
  chunkStatements,
  type D1Like,
  type D1PreparedStatement,
} from "./neurons-d1-write.ts";
import { NOMINATOR_POSITION_INSERT_COLUMNS } from "./account-nominator-positions.ts";
import {
  passTallyStatement,
  type PassTallyInput,
} from "./pass-completeness.ts";

type Row = Record<string, unknown>;

export interface NominatorPositionsWrite {
  /** Coerced rows, NOMINATOR_POSITION_INSERT_COLUMNS shape. */
  rows: Row[];
  /** Per-coldkey max captured_at -- NOT one batch-wide value. */
  coldkeyMaxCapturedAt: Map<string, number>;
}

/**
 * Write one nominator-positions sync batch to D1: upsert the latest-only
 * ledger, then drop each covered coldkey's rows that this batch did not
 * refresh (an unstaked position).
 *
 * Order matters and is preserved by batchInSlices: the prunes are appended
 * last, so the worst a mid-run slice failure can do is leave a stale position
 * behind until the next tick -- never delete a position without having written
 * its replacement first.
 */
export async function writeNominatorPositionsToD1(
  db: D1Like,
  { rows, coldkeyMaxCapturedAt }: NominatorPositionsWrite,
  /**
   * The producer's declared pass, when it declared one
   * (metagraphed-infra#346).
   *
   * IN THE SAME BATCH as the rows, deliberately, so the tally and the data it
   * describes commit together. A tally written separately could survive a
   * failed row write and report a pass complete that never landed -- which is
   * the exact lie this mechanism exists to prevent, arrived at from the other
   * direction.
   */
  pass?: PassTallyInput | null,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = chunkStatements(
    db,
    "nominator_positions",
    NOMINATOR_POSITION_INSERT_COLUMNS,
    ["coldkey", "hotkey", "netuid"],
    rows,
  );

  for (const [coldkey, capturedAt] of coldkeyMaxCapturedAt) {
    statements.push(
      db
        .prepare(
          "DELETE FROM nominator_positions WHERE coldkey = ? AND captured_at < ?",
        )
        .bind(coldkey, capturedAt),
    );
  }

  if (pass)
    statements.push(passTallyStatement(db, "nominator-positions", pass));
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}

/**
 * Per-coldkey max captured_at for one batch -- the prune's cutoff map.
 *
 * Pure and exported so the handler can build it without a database and the
 * test can assert the "later capture wins" rule directly. Rows whose coldkey
 * or captured_at is unusable are skipped rather than seeding a cutoff of NaN,
 * which would delete every row for that coldkey.
 */
export function coldkeyMaxCapturedAt(rows: Row[]): Map<string, number> {
  const cutoffs = new Map<string, number>();
  for (const row of rows) {
    const coldkey = typeof row?.coldkey === "string" ? row.coldkey : null;
    const capturedAt = row?.captured_at;
    if (!coldkey || !Number.isFinite(capturedAt as number)) continue;
    const current = cutoffs.get(coldkey);
    if (current == null || (capturedAt as number) > current) {
      cutoffs.set(coldkey, capturedAt as number);
    }
  }
  return cutoffs;
}
