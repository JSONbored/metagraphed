// The validator-nominator-counts sync write path, against D1 (#9146).
//
// The last of the five Postgres-backed poller lanes to get a Cloudflare-native
// sink. Its producer (metagraphed-infra's
// src/bin/poller/jobs/validator_nominators.rs) already runs in the poller
// Container and already performs the full SubtensorModule::Alpha scan this
// table is derived from -- it is disabled purely because it writes to a
// Postgres that no longer exists. This module is the store it writes to
// instead; migrations/d1/0011_validator_nominator_counts.sql is the table.
//
// Everything structural is imported from src/neurons-d1-write.ts rather than
// re-derived -- D1_PARAM_BUDGET, chunkStatements, batchInSlices -- so the
// binding's 100-bound-parameter limit is enforced in exactly one place. That
// limit is not theoretical here: at 3 columns this table chunks to 30 rows a
// statement, and a full 112,550-row scan is ~3,752 statements, so a
// hand-rolled batch would have hit the same wall #9157 hit in production.
//
// buildUpsert's trailing `captured_at <= excluded.captured_at` guard is
// exactly right for this table and is why chunkStatements is reused verbatim
// instead of forked: the producer chunks one scan across several requests and
// re-sends on failure, so an out-of-order or replayed batch must be a no-op
// rather than a regression to an older count.

import {
  batchInSlices,
  chunkStatements,
  type D1Like,
  type D1PreparedStatement,
} from "./neurons-d1-write.ts";
import { VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS } from "./validator-nominator-summary.ts";
import {
  passTallyStatement,
  type PassTallyInput,
} from "./pass-completeness.ts";

type Row = Record<string, unknown>;

/**
 * Write one batch of nominator counts to D1: a latest-only upsert on
 * (hotkey), nothing else.
 *
 * NO PRUNE, and no history append -- see the migration's header for both. An
 * empty batch issues no statements at all rather than an empty `db.batch([])`,
 * matching writeAccountIdentityToD1's own guard.
 */
export async function writeValidatorNominatorCountsToD1(
  db: D1Like,
  rows: Row[],
  /** The producer's declared pass, batched with the rows so the tally and the
   * data it describes commit together (metagraphed-infra#346). */
  pass?: PassTallyInput | null,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = chunkStatements(
    db,
    "validator_nominator_counts",
    VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
    ["hotkey"],
    rows,
  );
  if (pass)
    statements.push(passTallyStatement(db, "validator-nominator-counts", pass));
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
