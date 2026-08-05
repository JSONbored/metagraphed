// The account-balances sync write path, against D1 (#9478).
//
// The last of the frozen account-tier ledgers to get a Cloudflare-native sink,
// and the only one that never had a D1 table at all: `account_balances` lived
// solely in the decommissioned box's Postgres, so /api/v1/accounts/top-holders
// has been serving a one-shot materialization taken 2026-08-02 with a
// `captured_at` that cannot advance. migrations/d1/0017_account_balances.sql is
// the table; this module is the writer.
//
// SHAPE MIRRORS src/validator-nominator-counts-d1-write.ts, not the
// nominator-positions one, and the difference is the prune. That lane deletes a
// coldkey's rows its own batch did not refresh, because an unstaked position
// genuinely stops existing. Here the producer SKIPS an account whose free and
// reserved are both zero rather than writing zeros, so "absent from the batch"
// carries no information about the account's balance -- a prune would delete
// exactly the wallets that emptied. This table is "every account that has ever
// held a balance", which is what the retired Postgres handler meant too.
//
// Everything structural is imported from src/neurons-d1-write.ts rather than
// re-derived -- D1_PARAM_BUDGET, chunkStatements, batchInSlices -- so the
// binding's 100-bound-parameter limit is enforced in exactly one place. That
// limit bites hard on this lane: at 4 columns the table chunks to 25 rows a
// statement, so one 25,000-row request alone is 1,000 statements and a full
// ~540k-row pass is ~21,700 -- a hand-rolled batch would have hit the same wall
// #9157 hit in production.
//
// buildUpsert's trailing `captured_at <= excluded.captured_at` guard is why
// chunkStatements is reused verbatim rather than forked: a full pass arrives
// across ~22 requests and the producer re-sends on failure, so a replayed or
// out-of-order batch must be a no-op rather than a regression to an older
// balance.

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
 * It lives HERE rather than in a reader module -- unlike
 * NOMINATOR_POSITION_INSERT_COLUMNS (src/account-nominator-positions.ts) or
 * VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS (src/validator-nominator-summary.ts)
 * -- because this table has no reader of its own yet: the leaderboard that will
 * consume it composes three separate sources and is a different change. The
 * writer owns the write contract until something reads it.
 */
export const ACCOUNT_BALANCE_INSERT_COLUMNS = [
  "ss58",
  "free_tao",
  "reserved_tao",
  "captured_at",
];

/**
 * Write one account-balances sync batch to D1: a latest-only upsert on (ss58),
 * nothing else.
 *
 * NO PRUNE -- see this module's header and the migration's for why deleting an
 * account absent from a batch would delete the wallets that emptied. An empty
 * batch issues no statements at all rather than an empty `db.batch([])`,
 * matching writeValidatorNominatorCountsToD1's own guard.
 */
export async function writeAccountBalancesToD1(
  db: D1Like,
  rows: Row[],
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = chunkStatements(
    db,
    "account_balances",
    ACCOUNT_BALANCE_INSERT_COLUMNS,
    ["ss58"],
    rows,
  );
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
