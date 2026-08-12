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

interface StatementClientLike {
  first(text: string, values?: unknown[]): Promise<unknown>;
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
  neurons: "neurons_passes",
  // Absent until #10124, which is why account_balances_passes had ZERO rows in
  // Neon while D1's copy filled: writeAccountBalancesToStore takes the pass and
  // writes the tally, but mirrorLedgerToNeon skips any lane missing from this
  // map -- silently, since a lane with no pass table is a legitimate state.
  //
  // `scanned` and `outcome` exist on the D1 table and on Neon's, and NEITHER
  // writer sets them; they are nullable leftovers. So the generic four-column
  // tally is not a narrowing here -- it writes exactly what D1's own statement
  // writes.
  "account-balances": "account_balances_passes",
  // Absent until #10137, for the same reason account-balances was: the D1
  // writer takes the pass and writes the tally itself, so D1's copy filled
  // while Neon's stayed empty. A lane missing from this map is skipped by the
  // mirror without complaint, because "no pass table" is a legitimate state.
  "hotkey-alpha": "hotkey_alpha_passes",
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
  db: StatementClientLike | null | undefined,
  lane: string,
): Promise<PassCompleteness> {
  const table = PASS_TABLES[lane];
  if (!table || !db?.first) return { ...NONE, reason: "unavailable" };
  try {
    const row = (await db.first(
      `SELECT captured_at, expected_rows, received_rows
         FROM ${table}
        WHERE completed_at IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1`,
    )) as {
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

// passTallyStatement retired here (#10909): the D1-era statement builder's
// only remaining callers were its own tests -- the live write path has been
// writePassTallyToNeon since the cutover, and a builder that exists to feed a
// deleted store's batch() is scaffolding, not API.

/** The runner shape `createPgSql` hands out. Structural, so a test can assert
 * the emitted text and values without a database. */
export interface PassTallySql {
  unsafe(text: string, values?: unknown[]): Promise<unknown>;
}

export interface PassTallyWrite {
  ok: boolean;
  reason?: string;
}

/**
 * The same tally, against Postgres.
 *
 * WHY THIS IS NOT A `?`-TO-`$n` TRANSLATION of the statement above. Postgres
 * infers a parameter's type from the context it appears in, and inside a VALUES
 * list the only context is the target column. `completed_at` is filled by a
 * CASE whose OPERANDS are parameters, and a comparison gives Postgres nothing
 * to infer from, so `$4 >= $5` resolves to text and the whole statement is
 * rejected before it runs:
 *
 *     column "completed_at" is of type bigint but expression is of type text
 *
 * Loud rather than silent, which is luck rather than design -- the same shape
 * in a context Postgres CAN coerce would compare `'9' >= '100'`, which is TRUE
 * as text and FALSE as integer, and would stamp an incomplete pass complete.
 * The casts below are therefore written for the semantics, not for the error.
 *
 * ONE STATEMENT, so the read-modify-write of `received_rows` stays inside the
 * upsert. Reading the running total into the Worker and writing back a sum
 * would race every other chunk of the same pass.
 */
export async function writePassTallyToNeon(
  sql: PassTallySql,
  lane: string,
  pass: PassTallyInput,
): Promise<PassTallyWrite> {
  const table = PASS_TABLES[lane];
  if (!table) {
    // Same posture as the D1 builder: a writer names its own lane, so an
    // unknown one is a programming error rather than a runtime condition.
    throw new Error(
      `pass-completeness: no pass table for lane ${lane}; add it to PASS_TABLES ` +
        `and ship the migration, or the tally has nowhere to land`,
    );
  }
  try {
    await sql.unsafe(
      `INSERT INTO ${table}
         (captured_at, expected_rows, received_rows, completed_at)
       VALUES ($1::bigint, $2::int, $3::int,
               CASE WHEN $4::int >= $5::int THEN $6::bigint ELSE NULL END)
       ON CONFLICT (captured_at) DO UPDATE SET
         expected_rows = EXCLUDED.expected_rows,
         received_rows = ${table}.received_rows + EXCLUDED.received_rows,
         completed_at = COALESCE(
           ${table}.completed_at,
           CASE
             WHEN ${table}.received_rows + EXCLUDED.received_rows
                  >= EXCLUDED.expected_rows
             THEN $7::bigint
             ELSE NULL
           END
         )`,
      [
        pass.capturedAt,
        pass.expectedRows,
        pass.receivedRows,
        pass.receivedRows,
        pass.expectedRows,
        pass.nowMs,
        pass.nowMs,
      ],
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error) };
  }
}
