// The hotkey-alpha sync write path, against D1 (#9502).
//
// `delegated_tao`'s missing input. A coldkey's `nominator_positions.share_fraction`
// is a dimensionless slice of a (hotkey, netuid) alpha POOL, and nothing in
// either store held that pool's total: `neurons.stake_tao` covers only hotkeys
// registered on that exact subnet, which is 512 of the 13,724 (hotkey, netuid)
// pairs the positions actually name. migrations/d1/0019_hotkey_alpha.sql is the
// table; this module is the writer.
//
// SHAPE MIRRORS src/account-balances-d1-write.ts exactly, including the prune
// posture -- the producer skips a zero pool rather than writing a zero row, so
// "absent from this batch" says nothing about a pool's size and a prune would
// delete exactly the hotkeys that emptied. Upsert-only, never deleting.
//
// The one structural difference is the KEY: a composite (hotkey, netuid) rather
// than a single column. chunkStatements takes the conflict target as a list
// precisely so this needs no fork -- the same D1_PARAM_BUDGET arithmetic
// applies, at 4 columns to 25 rows a statement.
//
// The trailing `captured_at <= excluded.captured_at` guard buildUpsert appends
// is load-bearing here for the same reason it is on the balances lane: a full
// pass arrives across many requests and the producer re-sends on failure, so a
// replayed or out-of-order batch must be a no-op rather than a regression to an
// older pool size.

import {
  batchInSlices,
  chunkStatements,
  type D1Like,
  type D1PreparedStatement,
} from "./neurons-d1-write.ts";

type Row = Record<string, unknown>;

/**
 * The writer's exact column list and order, and the single source the route's
 * validator, the migration's drift test and the producer's payload all agree
 * against.
 *
 * `total_alpha` is ALPHA, not TAO. Converting needs the subnet's alpha price
 * (daily, from `subnet_snapshots`) and belongs to the reader that prices a
 * position, not to this write path -- storing the unit the producer measured
 * keeps the column one hop from the chain.
 */
export const HOTKEY_ALPHA_INSERT_COLUMNS = [
  "hotkey",
  "netuid",
  "total_alpha",
  "captured_at",
];

/**
 * One pass's completeness accounting, when the producer declares it.
 *
 * The twin of AccountBalancesPass, and deliberately a separate type rather than
 * a shared generic: the two lanes' tallies live in different tables and can
 * diverge in shape, and collapsing them would make a change to one silently a
 * change to both.
 */
export interface HotkeyAlphaPass {
  capturedAt: number;
  expectedRows: number;
  receivedRows: number;
  /** Injected rather than read from the clock so a test can pin it. */
  nowMs: number;
}

/**
 * The statement that advances a pass's row tally, upserted on (captured_at).
 *
 * `completed_at` is set by whichever request brings the running total up to
 * `expected_rows`, and never cleared afterwards -- a replayed request adds its
 * rows again and would otherwise un-complete a finished pass. Over-counting on
 * replay is deliberate and harmless: the reader asks "is completed_at set",
 * never "does the count match exactly", precisely so an at-least-once producer
 * cannot leave a complete pass looking unfinished.
 */
export function hotkeyAlphaPassStatement(
  db: D1Like,
  pass: HotkeyAlphaPass,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO hotkey_alpha_passes
         (captured_at, expected_rows, received_rows, completed_at)
       VALUES (?, ?, ?, CASE WHEN ? >= ? THEN ? ELSE NULL END)
       ON CONFLICT (captured_at) DO UPDATE SET
         expected_rows = excluded.expected_rows,
         received_rows = hotkey_alpha_passes.received_rows + excluded.received_rows,
         completed_at = COALESCE(
           hotkey_alpha_passes.completed_at,
           CASE
             WHEN hotkey_alpha_passes.received_rows + excluded.received_rows
                  >= excluded.expected_rows
             THEN ?
             ELSE NULL
           END
         )`,
    )
    .bind(
      pass.capturedAt,
      pass.expectedRows,
      pass.receivedRows,
      pass.receivedRows,
      pass.expectedRows,
      pass.nowMs,
      pass.nowMs,
    );
}

/**
 * Write one hotkey-alpha sync batch to D1: a latest-only upsert on
 * (hotkey, netuid), plus this pass's completeness tally when the producer
 * declared one.
 *
 * NO PRUNE -- see this module's header and the migration's. An empty batch
 * issues no statements at all rather than an empty `db.batch([])`, matching
 * writeAccountBalancesToD1's own guard.
 *
 * THE PASS STATEMENT IS APPENDED LAST, for writeAccountBalancesToD1's reason
 * exactly: batchInSlices splits a large statement list across several
 * `db.batch()` calls, so no single transaction spans them, and the only safe
 * ordering is the one where a mid-run failure UNDER-counts. Rows land, then the
 * tally moves; a pass can look less complete than it is, never more. The
 * reverse would mark a pass complete over rows that never arrived, which is the
 * lie the tally exists to prevent.
 */
export async function writeHotkeyAlphaToD1(
  db: D1Like,
  rows: Row[],
  pass?: HotkeyAlphaPass | null,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = chunkStatements(
    db,
    "hotkey_alpha",
    HOTKEY_ALPHA_INSERT_COLUMNS,
    ["hotkey", "netuid"],
    rows,
  );
  if (pass && statements.length) {
    statements.push(hotkeyAlphaPassStatement(db, pass));
  }
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
