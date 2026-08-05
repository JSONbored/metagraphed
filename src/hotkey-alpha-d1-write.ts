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
 * Write one hotkey-alpha sync batch to D1: a latest-only upsert on
 * (hotkey, netuid), nothing else.
 *
 * NO PRUNE -- see this module's header and the migration's. An empty batch
 * issues no statements at all rather than an empty `db.batch([])`, matching
 * writeAccountBalancesToD1's own guard.
 */
export async function writeHotkeyAlphaToD1(
  db: D1Like,
  rows: Row[],
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = chunkStatements(
    db,
    "hotkey_alpha",
    HOTKEY_ALPHA_INSERT_COLUMNS,
    ["hotkey", "netuid"],
    rows,
  );
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
