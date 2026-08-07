// "Did this lane's whole scan arrive?" — one implementation (metagraphed-infra#346).
//
// THE QUESTION A ROW COUNT CANNOT ANSWER. `ORDER BY … LIMIT n` over a partial
// ledger returns the largest values PRESENT, not the largest that EXIST — a
// well-formed leaderboard quietly missing its #2. Production served exactly
// that on 2026-08-05: 147,000 `account_balances` rows, every one correct, and
// the second-largest free balance on the network simply absent. The serving
// guard was `results.length === 0`, and 147,000 clears it.
//
// Completeness is not observable in the ledger. 147,000 well-formed rows look
// exactly like 364,000 of them, only fewer. So the producer declares its pass
// size up front — it can, because these lanes buffer the whole walk before
// posting anything — and a `*_passes` table tallies what actually landed.
//
// WHY THIS IS PARAMETERIZED, when `account-balances-completeness.ts` and
// `hotkey-alpha-completeness.ts` are not. Those two came first, one per lane,
// and were right to: there were two. Adding a third and fourth copy of the same
// sixty lines is where that stops being right. Both existing modules gate
// published leaderboards today, so folding them onto this belongs in its own
// diff rather than riding along with the lanes that had no gate at all — but
// they should move, and the shapes are identical on purpose so that it is a
// mechanical change when someone does.

interface D1Like {
  prepare(sql: string): {
    first(): Promise<unknown>;
  };
}

export interface PassCompleteness {
  /** captured_at of the newest pass that fully landed, or null if none has. */
  capturedAt: number | null;
  /** What that pass declared it would deliver. Null when capturedAt is null. */
  expectedRows: number | null;
  /** What actually landed under that stamp. */
  receivedRows: number | null;
  /** Why a caller may not read yet, or null when it may. */
  reason: "no_complete_pass" | "unavailable" | null;
}

const NONE: PassCompleteness = {
  capturedAt: null,
  expectedRows: null,
  receivedRows: null,
  reason: "no_complete_pass",
};

/**
 * The pass tables this reader will query.
 *
 * AN ALLOWLIST, because the table name is interpolated into SQL. D1 has no
 * placeholder for an identifier, so the only safe formulation is one that
 * cannot take an arbitrary string — a caller passing a lane name that is not
 * here gets a decline, not a query.
 */
export const PASS_TABLES: Readonly<Record<string, string>> = {
  "nominator-positions": "nominator_positions_passes",
  "validator-nominator-counts": "validator_nominator_counts_passes",
};

/**
 * The newest COMPLETE pass for a lane, or a decline.
 *
 * Keys on `completed_at IS NOT NULL` rather than on arithmetic over the counts.
 * The transport is at-least-once — a retried chunk adds its rows again — so
 * `received_rows` can legitimately exceed `expected_rows`, and an equality
 * check would call a finished pass unfinished. The stamp is set once by
 * whichever write closed the gap and is never cleared.
 *
 * DECLINES rather than throwing on a missing binding, an unknown lane, or a
 * failed query. A table that does not exist yet lands in the same place, which
 * matters here because D1 migrations in this repo are applied by hand: the
 * window between deploying this code and applying `0029` must read as "do not
 * rank", not as a 500.
 */
export async function latestCompletePass(
  db: D1Like | null | undefined,
  lane: string,
): Promise<PassCompleteness> {
  const table = PASS_TABLES[lane];
  if (!table || !db?.prepare) return { ...NONE, reason: "unavailable" };
  try {
    const row = (await db
      .prepare(
        `SELECT captured_at, expected_rows, received_rows
           FROM ${table}
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
    return { ...NONE, reason: "unavailable" };
  }
}

/**
 * The predicate a reader should gate on.
 *
 * Deliberately NOT "are there rows" — that is the check this whole mechanism
 * exists to replace. A caller that reads must additionally scope its query to
 * `capturedAt`, or it mixes the complete pass with whatever partial one landed
 * after it.
 */
export function mayReadPass(
  completeness: PassCompleteness,
): completeness is PassCompleteness & { capturedAt: number } {
  return completeness.reason === null && completeness.capturedAt !== null;
}

/** One chunk's contribution to a pass tally, as the producer declared it. */
export interface PassTallyInput {
  capturedAt: number;
  expectedRows: number;
  receivedRows: number;
  nowMs: number;
}

/**
 * The upsert that accumulates a pass, for a lane's own table.
 *
 * `completed_at` is COALESCEd rather than recomputed, so the first write that
 * closes the gap owns the stamp and a later retry cannot move it. The
 * comparison is `>=`, never `=`, precisely so an at-least-once producer cannot
 * leave a complete pass looking unfinished.
 *
 * THROWS for a lane with no table, rather than returning null. A writer calls
 * this with its OWN hardcoded lane name, so an unknown one is a programming
 * error and not a runtime condition — the same posture `packSyncBatchMessages`
 * takes for a pruning lane with no declared key. Returning null instead would
 * put a permanently-false branch in every caller, which is how a file starts
 * collecting coverage pragmas instead of reasons.
 */
export function passTallyStatement<S>(
  db: { prepare(sql: string): { bind(...values: unknown[]): S } },
  lane: string,
  pass: PassTallyInput,
): S {
  const table = PASS_TABLES[lane];
  if (!table) {
    throw new Error(
      `pass-completeness: no pass table for lane ${lane}; add it to PASS_TABLES ` +
        `and ship the migration, or the tally has nowhere to land`,
    );
  }
  return db
    .prepare(
      `INSERT INTO ${table}
         (captured_at, expected_rows, received_rows, completed_at)
       VALUES (?, ?, ?, CASE WHEN ? >= ? THEN ? ELSE NULL END)
       ON CONFLICT (captured_at) DO UPDATE SET
         expected_rows = excluded.expected_rows,
         received_rows = ${table}.received_rows + excluded.received_rows,
         completed_at = COALESCE(
           ${table}.completed_at,
           CASE
             WHEN ${table}.received_rows + excluded.received_rows
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
