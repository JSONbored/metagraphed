// Bulk writes into Neon (metagraphed-infra#336), the write half the pilot never
// had.
//
// THE PILOT SHIPPED A READ AND NO WRITER. Neon took one load on 2026-08-05
// 19:35 and froze there, while `GET /api/v1/accounts/{ss58}/subnets/{netuid}/
// history` was already reading it -- so that route served a two-day-old
// snapshot until metagraphed#9705 unbound Hyperdrive. Nothing checked the pair,
// because a store with no writer looks exactly like a store with a slow one
// until you read its MAX().
//
// So this file exists before any read moves back, and the rule it encodes is:
// a lane is not on Neon until a producer tick has been observed landing in it.
//
// ## Why this is NOT `src/neurons-d1-write.ts` with a different runner
//
// `createPgSql` is deliberately interface-compatible with `createD1Sql`, and
// that is enough for the READ path -- a route moves store by being handed a
// different `sql`. The WRITE path cannot follow, because its SQL is not
// portable: D1 caps a statement at 100 bound parameters, so the bulk writes
// there smuggle whole chunks through a single JSON parameter and unpack them
// with `json_each` / `json_extract`. That is a workaround for a limit Postgres
// does not have.
//
// Postgres takes 65,535 parameters per statement, so the honest form -- a plain
// multi-row `INSERT ... VALUES` -- is both simpler and faster here. At 22
// columns that is 2,978 rows in one statement against D1's four.
//
// ## Best-effort, and never in front of the D1 write
//
// Every function here returns a result rather than throwing. During dual-write
// the D1 write is still the one the routes read, so a Neon failure must cost a
// mirror and a lane verdict -- not the pass. That inverts once a lane's read
// moves, and the invariant that makes the inversion safe is the lane verdict
// this records on every attempt: metagraphed#9698 reads it, so a Neon store
// that stops accepting writes surfaces the same way any other lane does.

import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/**
 * Postgres' hard ceiling on bound parameters in one statement.
 *
 * 65,535 -- the wire protocol counts them in an int16. Exceeding it is a
 * protocol error rather than a slow query, so this is a real bound and not a
 * tuning knob, which is why it is stated here rather than folded into a
 * chunk-size constant somebody could later "optimise".
 */
export const PG_PARAM_LIMIT = 65_535;

/**
 * How much of that ceiling one statement may use.
 *
 * EIGHTY PERCENT. The headroom is not superstition: a chunk sized exactly to
 * the limit leaves no room for a column being added to the write, and adding a
 * column is the single most likely future edit to these tables. At 80% a 22-
 * column write can gain five more columns before the chunk size has to change.
 */
export const PG_PARAM_BUDGET = Math.floor(PG_PARAM_LIMIT * 0.8);

/** How many rows of `columnCount` columns fit in one statement. Never zero --
 * a single row always gets its own statement, even if it is somehow wider than
 * the budget, so the caller gets a Postgres error naming the real problem
 * rather than an empty write that silently succeeded. */
export function rowsPerPgStatement(columnCount: number): number {
  if (columnCount <= 0) return 1;
  return Math.max(1, Math.floor(PG_PARAM_BUDGET / columnCount));
}

/**
 * `($1, $2, $3), ($4, $5, $6), ...` for `rowCount` rows of `columnCount`.
 *
 * The numbering IS the contract. Postgres placeholders are 1-based and
 * positional, and an off-by-one does not throw -- it binds the value to the
 * wrong column, which is a wrong row written confidently. Exported so a test
 * can assert the built text directly, which is cheaper than discovering it
 * from a wrong answer in production.
 */
export function pgValuesClause(rowCount: number, columnCount: number): string {
  const groups: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const params: string[] = [];
    for (let col = 0; col < columnCount; col += 1) {
      params.push(`$${row * columnCount + col + 1}`);
    }
    groups.push(`(${params.join(", ")})`);
  }
  return groups.join(", ");
}

/**
 * A multi-row upsert.
 *
 * `conflict` names the natural key; the columns that are NOT part of it get
 * `DO UPDATE`. An empty `conflict` means a plain append, which is what the
 * history tables want.
 *
 * `guard` is an optional `WHERE` on the DO UPDATE -- the Postgres spelling of
 * the out-of-order protection `buildUpsert` applies in D1: an older capture
 * arriving after a newer one must be a no-op, not a regression. Two lanes here
 * retry, so an out-of-order arrival is a real event and not a hypothetical.
 */
export function buildPgUpsert(
  table: string,
  columns: readonly string[],
  conflict: readonly string[],
  rowCount: number,
  guard?: string,
): string {
  const head =
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ` +
    pgValuesClause(rowCount, columns.length);
  if (conflict.length === 0) return head;
  const updates = columns
    .filter((column) => !conflict.includes(column))
    .map((column) => `${column} = EXCLUDED.${column}`);
  if (updates.length === 0) {
    // Every column is part of the key, so there is nothing an update could
    // change. DO NOTHING rather than an empty SET, which is a syntax error.
    return `${head} ON CONFLICT (${conflict.join(", ")}) DO NOTHING`;
  }
  const where = guard ? ` WHERE ${guard}` : "";
  return (
    `${head} ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ` +
    `${updates.join(", ")}${where}`
  );
}

/** Rows -> a flat parameter list, in the column order given. `undefined` is
 * normalised to null: `pg` rejects undefined, and a row that is merely missing
 * a key is an ordinary shape here rather than an error. */
export function pgFlatValues(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): unknown[] {
  const values: unknown[] = [];
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column];
      values.push(value === undefined ? null : value);
    }
  }
  return values;
}

/** The one method this needs from `PgSql`, so a test can hand a plain
 * function and a caller can hand the real runner. */
export interface PgUnsafe {
  unsafe(text: string, values?: unknown[]): Promise<unknown>;
}

export interface NeonWriteResult {
  ok: boolean;
  /** Rows this call attempted. Reported even on failure, because "how much did
   * not land" is the triage question. */
  rows: number;
  statements: number;
  reason?: string;
}

/**
 * Write `rows` into `table`, chunked to fit Postgres' parameter ceiling.
 *
 * STOPS AT THE FIRST FAILED CHUNK, unlike the poller's chunked POST, and the
 * difference is not an inconsistency. There, each chunk was a whole set of
 * netuids and the sink pruned per netuid, so chunk 4 did not depend on chunk 3.
 * Here every chunk is part of one logical write into one table, and continuing
 * past a failure would leave a partial state that the row count reports as
 * nearly complete. The count of what did land is in the result either way.
 */
export async function writeRowsToNeon(
  sql: PgUnsafe | null | undefined,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  conflict: readonly string[] = [],
  guard?: string,
): Promise<NeonWriteResult> {
  if (!sql?.unsafe)
    return { ok: false, rows: 0, statements: 0, reason: "unbound" };
  if (rows.length === 0) return { ok: true, rows: 0, statements: 0 };
  if (columns.length === 0) {
    return { ok: false, rows: 0, statements: 0, reason: "no_columns" };
  }
  const perStatement = rowsPerPgStatement(columns.length);
  let written = 0;
  let statements = 0;
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const text = buildPgUpsert(table, columns, conflict, chunk.length, guard);
    try {
      await sql.unsafe(text, pgFlatValues(chunk, columns));
    } catch (error) {
      return {
        ok: false,
        rows: written,
        statements,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    written += chunk.length;
    statements += 1;
  }
  return { ok: true, rows: written, statements };
}

/**
 * Record one Neon write's outcome as a lane verdict.
 *
 * THIS IS THE INVARIANT THE PILOT WAS MISSING. A store with no lane is
 * invisible to metagraphed#9698's reader, and a frozen Neon serving 200 OK with
 * plausible rows is indistinguishable from a healthy one -- which is exactly
 * how a two-day-old snapshot reached the public API unnoticed.
 *
 * `age_ms` is deliberately null: this is a write outcome, and there is no
 * meaningful "how far behind" to report from inside a single write. Inventing
 * one would put a fabricated number in the column triage reads.
 */
export async function recordNeonWriteVerdict(
  db: LaneHealthDb | null | undefined,
  lane: string,
  result: NeonWriteResult,
  nowMs: number,
): Promise<boolean> {
  return recordLaneVerdict(db, {
    lane: `neon:${lane}`,
    verdict: result.ok ? "ok" : "stale",
    age_ms: null,
    detail: result.ok
      ? `${result.rows} row(s) in ${result.statements} statement(s)`
      : `${result.rows} row(s) written before failure: ${result.reason ?? "unknown"}`,
    checked_at: nowMs,
  });
}

/**
 * Which lanes dual-write into Neon, read from the environment.
 *
 * A COMMA LIST, DEFAULTING TO EMPTY, so this file changes nothing until a lane
 * is named. That matters more than usual here: the pilot's failure was a store
 * being used before it was ready, and a flag that defaults ON would repeat it
 * on the deploy that introduced the flag.
 *
 * Same shape as SYNC_QUEUE_LANES, so the two cutovers are read the same way.
 */
export function neonDualWriteLanes(
  env: Record<string, unknown> | null | undefined,
): Set<string> {
  const raw = env?.NEON_DUAL_WRITE_LANES;
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((lane) => lane.trim())
      .filter((lane) => lane.length > 0),
  );
}

/**
 * Which lanes READ from Neon. A separate flag from the write list, on purpose.
 *
 * THE CONFLATION IS WHAT BROKE THE PILOT. The read gate used to be "is
 * HYPERDRIVE bound", so binding the config for a WRITE pilot silently moved a
 * READ -- and `GET /api/v1/accounts/{ss58}/subnets/{netuid}/history` began
 * serving a store nothing had ever written to. "The binding exists" and "this
 * route should read Neon" are different questions and now have different
 * answers.
 *
 * Defaults to empty, so the binding can come back for the writer without any
 * read following it.
 */
export function neonReadLanes(
  env: Record<string, unknown> | null | undefined,
): Set<string> {
  const raw = env?.NEON_READ_LANES;
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((lane) => lane.trim())
      .filter((lane) => lane.length > 0),
  );
}

/** Whether `lane`'s reads should be served from Neon on this deployment. */
export function neonReadEnabled(
  env: Record<string, unknown> | null | undefined,
  lane: string,
): boolean {
  return neonReadLanes(env).has(lane);
}

/** Whether `lane` should mirror into Neon on this deployment. */
export function neonDualWriteEnabled(
  env: Record<string, unknown> | null | undefined,
  lane: string,
): boolean {
  return neonDualWriteLanes(env).has(lane);
}
