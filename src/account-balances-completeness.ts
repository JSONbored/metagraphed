// "Is the account_balances ledger safe to rank from?" (#9511)
//
// THE QUESTION A ROW COUNT CANNOT ANSWER. `ORDER BY free_tao DESC LIMIT n` over
// a partial ledger returns the largest balances PRESENT, not the largest that
// EXIST -- a well-formed leaderboard quietly missing its #2. Production served
// exactly that on 2026-08-05: 147,000 rows, every one correct, and the
// second-largest free balance on the network (737,821 TAO, live on chain)
// simply absent. The serving side's guard was `results.length === 0`, and
// 147,000 clears it.
//
// Completeness is not observable in the ledger itself. 147,000 well-formed rows
// look exactly like 554,136 well-formed rows, only fewer. So the producer
// declares its pass size up front -- it can, because metagraphed-infra#316 made
// it buffer the whole walk before posting anything -- and
// `account_balances_passes` (migrations/d1/0018) tallies what actually landed.
// This module is the reader over that tally.
//
// WHY NOT JUST TRUST THE PRODUCER'S OWN FLOOR. metagraphed-infra#316 already
// refuses to publish a truncated scan, and that closes the failure that
// actually happened. Two holes survive it, and both produce the same
// partial-load-that-looks-fresh shape:
//
//   1. A POST failing mid-sequence. A pass is ~15 requests; if the 7th fails,
//      the first six are committed under a fresh captured_at.
//   2. The floor is 80% of the last known network size, deliberately, so a
//      network that grew does not deadlock the lane. A pass covering 80-99%
//      clears it and publishes.
//
// Neither is a producer bug. Both are why the reader needs its own answer.

interface D1Like {
  prepare(sql: string): {
    first(): Promise<unknown>;
  };
}

export interface AccountBalancesCompleteness {
  /** captured_at of the newest pass that fully landed, or null if none has. */
  capturedAt: number | null;
  /** What that pass declared it would deliver. Null when capturedAt is null. */
  expectedRows: number | null;
  /** What actually landed under that stamp. */
  receivedRows: number | null;
  /** Why a caller may not rank yet, or null when it may. */
  reason: "no_complete_pass" | "unavailable" | null;
}

const NONE: AccountBalancesCompleteness = {
  capturedAt: null,
  expectedRows: null,
  receivedRows: null,
  reason: "no_complete_pass",
};

/**
 * The newest COMPLETE pass, or a decline.
 *
 * Keys on `completed_at IS NOT NULL` rather than on any arithmetic over the
 * counts. The producer is at-least-once -- it re-sends a chunk on failure -- so
 * a replayed request adds its rows again and `received_rows` can legitimately
 * exceed `expected_rows`. An equality check would call that finished pass
 * unfinished; the stamp is set once by whichever request closed the gap and is
 * never cleared.
 *
 * Returns a DECLINE rather than throwing on a missing binding or a failed
 * query, matching the cold-safety posture of every other tier reader here: a
 * leaderboard that cannot prove its inputs should fall back, not 500.
 */
export async function latestCompleteAccountBalancesPass(
  db: D1Like | null | undefined,
): Promise<AccountBalancesCompleteness> {
  if (!db?.prepare) return { ...NONE, reason: "unavailable" };
  try {
    const row = (await db
      .prepare(
        `SELECT captured_at, expected_rows, received_rows
           FROM account_balances_passes
          WHERE completed_at IS NOT NULL
          ORDER BY completed_at DESC
          LIMIT 1`,
      )
      .first()) as {
      captured_at?: unknown;
      expected_rows?: unknown;
      received_rows?: unknown;
    } | null;
    const capturedAt = Number(row?.captured_at);
    if (!row || !Number.isFinite(capturedAt) || capturedAt <= 0) return NONE;
    return {
      capturedAt,
      expectedRows: Number(row.expected_rows) || null,
      receivedRows: Number(row.received_rows) || null,
      reason: null,
    };
  } catch {
    // A table that does not exist yet (the migration is applied by hand) lands
    // here, and it means the same thing as "no complete pass": do not rank.
    return { ...NONE, reason: "unavailable" };
  }
}

/**
 * The predicate a ranking tier should gate on.
 *
 * Deliberately NOT "are there rows" -- that is the check #9511 is about. A
 * caller that ranks must additionally scope its query to `capturedAt`, or it
 * will mix the complete pass with whatever partial one landed after it.
 */
export function mayRankAccountBalances(
  completeness: AccountBalancesCompleteness,
): completeness is AccountBalancesCompleteness & { capturedAt: number } {
  return completeness.reason === null && completeness.capturedAt !== null;
}
