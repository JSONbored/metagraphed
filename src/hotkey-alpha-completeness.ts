// "Is the hotkey_alpha pool ledger safe to price positions from?" (#9502)
//
// The twin of src/account-balances-completeness.ts, and needed for a strictly
// stronger reason. That module exists because a partial `account_balances`
// yields the largest balances PRESENT rather than the largest that EXIST -- a
// leaderboard visibly missing an entry. A partial `hotkey_alpha` is quieter: a
// pool total that never arrived prices every position naming it against
// nothing, so those coldkeys' `delegated_tao` comes out merely too LOW. The
// ranking stays well-formed and plausible while being wrong, and no cell says
// so. Underpricing looks like data.
//
// AND THE READER CANNOT RECOVER COMPLETENESS BY COUNTING, even in principle.
// migrations/d1/0019's producer SKIPS a genuine zero pool rather than writing a
// zero row, so a missing (hotkey, netuid) means either "scanned, pool is empty"
// or "never scanned". The first is a true zero contribution; the second must
// decline the whole ranking. No query distinguishes them. A coverage ratio over
// `nominator_positions` -- the obvious reader-side proxy -- measures the two
// added together and cannot attribute the gap, which is why this asks the
// producer's own declaration instead of inferring one.
//
// See migrations/d1/0021_hotkey_alpha_passes.sql for what the producer's floor
// does and does not cover (a failed POST mid-sequence, and a 10%-of-762,577
// floor that leaves a wide publishing band).

interface D1Like {
  prepare(sql: string): {
    first(): Promise<unknown>;
  };
}

export interface HotkeyAlphaCompleteness {
  /** captured_at of the newest pass that fully landed, or null if none has. */
  capturedAt: number | null;
  /** What that pass declared it would deliver. Null when capturedAt is null. */
  expectedRows: number | null;
  /** What actually landed under that stamp. */
  receivedRows: number | null;
  /** Why a caller may not price yet, or null when it may. */
  reason: "no_complete_pass" | "unavailable" | null;
}

const NONE: HotkeyAlphaCompleteness = {
  capturedAt: null,
  expectedRows: null,
  receivedRows: null,
  reason: "no_complete_pass",
};

/**
 * The newest COMPLETE pass, or a decline.
 *
 * Keys on `completed_at IS NOT NULL` rather than on arithmetic over the counts,
 * for latestCompleteAccountBalancesPass's reason: the producer is at-least-once
 * and re-sends a chunk on failure, so `received_rows` can legitimately exceed
 * `expected_rows` and an equality check would call a finished pass unfinished.
 *
 * Returns a DECLINE rather than throwing on a missing binding or a failed
 * query, matching the cold-safety posture of every other tier reader here: a
 * leaderboard that cannot prove its inputs should fall back, not 500.
 */
export async function latestCompleteHotkeyAlphaPass(
  db: D1Like | null | undefined,
): Promise<HotkeyAlphaCompleteness> {
  if (!db?.prepare) return { ...NONE, reason: "unavailable" };
  try {
    const row = (await db
      .prepare(
        `SELECT captured_at, expected_rows, received_rows
           FROM hotkey_alpha_passes
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
    // A table that does not exist yet (migrations are applied by hand) lands
    // here, and it means the same thing as "no complete pass": do not price.
    return { ...NONE, reason: "unavailable" };
  }
}

/**
 * The predicate a pricing tier should gate on.
 *
 * Deliberately NOT "are there rows". A caller that prices must additionally
 * scope its read to `capturedAt`: unlike the balance ledger -- where a later
 * partial pass only refreshes rows and scoping would DROP accounts -- mixing
 * pool stamps here means valuing one coldkey's positions against totals read at
 * different blocks, which is a silently inconsistent sum rather than a stale
 * one.
 */
export function mayPriceHotkeyAlpha(
  completeness: HotkeyAlphaCompleteness,
): completeness is HotkeyAlphaCompleteness & { capturedAt: number } {
  return completeness.reason === null && completeness.capturedAt !== null;
}
