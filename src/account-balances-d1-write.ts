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
 * One pass's completeness accounting, when the producer declares it.
 *
 * `expectedRows` is what the producer says the whole pass will deliver -- a
 * number it knows because metagraphed-infra#316 made it buffer the walk before
 * posting anything. `receivedRows` is what THIS request carries. The statement
 * adds the second to a running total and stamps `completed_at` on the request
 * that closes the gap.
 */
export interface AccountBalancesPass {
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
export function accountBalancesPassStatement(
  db: D1Like,
  pass: AccountBalancesPass,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO account_balances_passes
         (captured_at, expected_rows, received_rows, completed_at)
       VALUES (?, ?, ?, CASE WHEN ? >= ? THEN ? ELSE NULL END)
       ON CONFLICT (captured_at) DO UPDATE SET
         expected_rows = excluded.expected_rows,
         received_rows = account_balances_passes.received_rows + excluded.received_rows,
         completed_at = COALESCE(
           account_balances_passes.completed_at,
           CASE
             WHEN account_balances_passes.received_rows + excluded.received_rows
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
 * Write one account-balances sync batch to D1: a latest-only upsert on (ss58),
 * plus this pass's completeness tally when the producer declared one.
 *
 * NO PRUNE -- see this module's header and the migration's for why deleting an
 * account absent from a batch would delete the wallets that emptied. An empty
 * batch issues no statements at all rather than an empty `db.batch([])`,
 * matching writeValidatorNominatorCountsToD1's own guard.
 *
 * THE PASS STATEMENT IS APPENDED LAST, deliberately. batchInSlices splits a
 * large statement list across several `db.batch()` calls, so there is no single
 * transaction spanning all of them -- and given that, the only safe ordering is
 * one where a mid-run failure UNDER-counts. Rows land, then the tally moves; a
 * pass can therefore look less complete than it is, never more. The reverse
 * would mark a pass complete over rows that never arrived, which is exactly the
 * lie #9511 is about.
 */
export async function writeAccountBalancesToD1(
  db: D1Like,
  rows: Row[],
  pass?: AccountBalancesPass | null,
): Promise<{ statements: number }> {
  const statements: D1PreparedStatement[] = chunkStatements(
    db,
    "account_balances",
    ACCOUNT_BALANCE_INSERT_COLUMNS,
    ["ss58"],
    rows,
  );
  if (pass) statements.push(accountBalancesPassStatement(db, pass));
  if (statements.length) await batchInSlices(db, statements);
  return { statements: statements.length };
}
