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

import {
  recordLaneVerdict,
  type LaneHealthDb,
  type LaneVerdict,
} from "./lane-health.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

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
  filter?: string,
  /**
   * Target types for the FILTERED form's columns, e.g. `{netuid: "int"}`.
   *
   * WHY ONLY THE FILTERED FORM NEEDS THEM (#10121). A plain
   * `INSERT INTO t (a, b) VALUES ($1, $2)` gives Postgres the target columns as
   * type context, so every parameter is inferred correctly and nothing has to
   * be declared. Wrapping the same list in `FROM (VALUES ...) AS src (a, b)`
   * removes that context entirely: `src` is a standalone relation, its columns
   * have no declared types, and every untyped parameter falls back to TEXT.
   *
   * The insert then fails with `column "netuid" is of type integer but
   * expression is of type text` -- which took the hotkey_alpha mirror down
   * TWICE. #10000 fixed only the predicate half (`src.netuid::int` inside the
   * EXISTS) and left the SELECT list handing text to an integer column.
   *
   * Declared per plan rather than discovered, because the failure is silent in
   * the direction that matters: an unlisted column is simply not cast, and if
   * its target happens to be text the statement works -- so a missing entry
   * surfaces only on the one table where it breaks.
   */
  columnTypes?: Readonly<Record<string, string>>,
): string {
  // `filter` switches the row source from a bare VALUES list to a SELECT over
  // it, so a predicate can reject rows before they are inserted. The D1 side
  // has had this since #9558 -- `chunkStatements` takes the same argument --
  // and its absence here is what let `hotkey_alpha` diverge: D1 stores only
  // pools a nominator_position references, the mirror stored everything, and
  // Neon ended up with ~29,000 rows D1 refuses on purpose (#9832).
  //
  // The alias is `src`, and the predicate refers to its columns by name.
  const head = filter
    ? `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns
        .map((c) =>
          columnTypes?.[c] ? `src.${c}::${columnTypes[c]}` : `src.${c}`,
        )
        .join(", ")} FROM (VALUES ${pgValuesClause(
        rowCount,
        columns.length,
      )}) AS src (${columns.join(", ")}) WHERE ${filter}`
    : `INSERT INTO ${table} (${columns.join(", ")}) VALUES ` +
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
  filter?: string,
  /** Target types for the filtered form -- see buildPgUpsert. */
  columnTypes?: Readonly<Record<string, string>>,
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
    const text = buildPgUpsert(
      table,
      columns,
      conflict,
      chunk.length,
      guard,
      filter,
      columnTypes,
    );
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
 * Delete each key's rows older than that key's own cutoff.
 *
 * PER KEY, never batch-wide, and that is the whole contract. A full scan posts
 * in several requests, so a "delete everything older than this batch" sweep
 * would let one request delete rows another just wrote. The cutoff is therefore
 * each key's OWN max captured_at, exactly as the D1 writer computes it.
 *
 * Runs AFTER the upsert and reports its own outcome: the worst a failure here
 * can do is leave a stale row until the next tick, never delete one whose
 * replacement was not written first.
 */
export async function pruneKeysInNeon(
  sql: PgUnsafe | null | undefined,
  table: string,
  keyColumn: string,
  cutoffs: ReadonlyMap<string, number>,
): Promise<NeonWriteResult> {
  if (!sql?.unsafe)
    return { ok: false, rows: 0, statements: 0, reason: "unbound" };
  if (cutoffs.size === 0) return { ok: true, rows: 0, statements: 0 };
  // One statement for the whole map rather than one per key: a 24,000-coldkey
  // pass would otherwise be 24,000 round trips through Hyperdrive. The pairs
  // travel as two parallel arrays and are joined with UNNEST, which keeps the
  // parameter count at two regardless of size.
  const keys = [...cutoffs.keys()];
  const values = keys.map((key) => cutoffs.get(key) as number);
  try {
    await sql.unsafe(
      `DELETE FROM ${table} USING UNNEST($1::text[], $2::bigint[]) ` +
        `AS cutoff(k, at) WHERE ${table}.${keyColumn} = cutoff.k ` +
        `AND ${table}.captured_at < cutoff.at`,
      [keys, values],
    );
  } catch (error) {
    return {
      ok: false,
      rows: 0,
      statements: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, rows: cutoffs.size, statements: 1 };
}

/**
 * How long an UNCHANGED `ok` verdict may be re-asserted without writing again.
 *
 * TEN MINUTES, against a bound of two hours. `lane_health`'s own freshness
 * expectation is `2 * HOUR` (src/table-freshness-watchdog.ts, "every watchdog
 * writes here; silence means they all stopped"), so a heartbeat at ten minutes
 * sits twelve ticks inside the contract that already exists -- the window can
 * be widened later without renegotiating anything, and a lane that genuinely
 * dies still trips the same watchdog at the same threshold it always did.
 */
export const NEON_WRITE_VERDICT_COALESCE_MS = 10 * 60 * 1000;

/**
 * The last verdict actually WRITTEN per lane, per isolate.
 *
 * Per-isolate is the honest description and not a caveat to apologise for: a
 * fresh isolate simply writes once more than it strictly had to, which is the
 * safe direction. The map is bounded by the lane set (~50 compile-time
 * constants, never user input), so it cannot grow without bound.
 *
 * It gates WRITES ONLY. Every read of lane health still goes to the database,
 * so a stale or missing entry here can never produce a wrong verdict -- at
 * worst it produces a redundant row.
 */
const lastWrittenVerdict = new Map<
  string,
  { verdict: LaneVerdict; checkedAt: number }
>();

/**
 * Forget which verdicts have been written, so the next one is unconditional.
 *
 * Exported for tests, which drive many mirror runs through one isolate on a
 * frozen clock — a shape production never has, and one where a coalesced write
 * looks like a missing write. Registered centrally too, so the memo cannot leak
 * ACROSS test files (see src/module-state-registry.ts).
 */
export function resetNeonWriteVerdictMemo(): void {
  lastWrittenVerdict.clear();
}

registerModuleStateReset("src/neon-write.ts", resetNeonWriteVerdictMemo);

/**
 * Whether this verdict has to be written, or is a repeat inside the window.
 *
 * Pure and exported so the policy can be asserted directly rather than
 * inferred from a mock's call count -- the same reason `pgValuesClause` above
 * is exported.
 *
 * THREE THINGS ALWAYS WRITE, and the order matters less than the fact that
 * none of them can be coalesced away:
 *
 *   1. A FAILURE. Never suppressed, however often it repeats. Failures are
 *      rare, so they cost no volume, and their `detail` carries the reason
 *      triage actually needs -- withholding it for up to ten minutes would
 *      trade the only thing worth having for nothing.
 *   2. A CHANGED VERDICT. `ok` -> `stale` is the transition every watchdog
 *      exists to catch, and delaying it by even one tick would make this a
 *      suppression rather than a coalescing.
 *   3. A LANE THIS ISOLATE HAS NOT SEEN, or one whose clock moved backwards
 *      (a replay, a fixed clock in a test, two isolates disagreeing). Unknown
 *      state resolves to "write", never to "skip".
 */
export function shouldWriteNeonWriteVerdict(
  previous: { verdict: LaneVerdict; checkedAt: number } | undefined,
  verdict: LaneVerdict,
  nowMs: number,
  coalesceMs: number = NEON_WRITE_VERDICT_COALESCE_MS,
): boolean {
  if (verdict !== "ok") return true;
  if (!previous) return true;
  if (previous.verdict !== verdict) return true;
  if (nowMs < previous.checkedAt) return true;
  return nowMs - previous.checkedAt >= coalesceMs;
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
 *
 * ## Why this coalesces, and why that is not a weakened invariant
 *
 * The invariant above is "a Neon that stops accepting writes surfaces as a
 * lane", and it is satisfied by the NEWEST row per lane -- which is the only
 * row `loadLatestLaneHealth` ever reads (src/lane-health.ts: `WHERE (lane,
 * checked_at) IN (SELECT lane, MAX(checked_at) ...)`). Every additional row
 * written between two reads is written to be discarded.
 *
 * That cost was invisible while this was dual-write bookkeeping and became the
 * dominant one once Neon was the sole store: measured 2026-08-11, `lane_health`
 * took 8,953 writes in six hours, a maximum inter-write gap of 16.7s, and every
 * one of them carried a second statement (the retention DELETE inside
 * `recordLaneVerdict`). A gap that never reaches 60s is a compute that can
 * never autosuspend, at ~2.8% utilisation -- see #10659.
 *
 * So the repetition goes and the signal stays: failures and transitions write
 * immediately, and a steady `ok` heartbeats. `detail` is the one thing that
 * lags -- a coalesced `ok` holds the previous row count for up to the window --
 * and it lags deliberately, because it changes on EVERY write (row counts) and
 * keying on it would coalesce exactly nothing.
 */
export async function recordNeonWriteVerdict(
  db: LaneHealthDb | null | undefined,
  lane: string,
  result: NeonWriteResult,
  nowMs: number,
  /**
   * Whether this write went into the write-behind buffer rather than to Neon.
   *
   * A BUFFERED SUCCESS RECORDS NOTHING HERE (#10690). The verdict would say
   * "ok" for rows that are durably enqueued and not yet in Neon, which is a
   * weaker claim than the one the flush already records per lane -- and it
   * would be written at ~758/hr to say it. The flush owns the honest verdict;
   * this path owning a second, vaguer one is how the buffer ends up costing a
   * Neon write per write it was built to defer.
   *
   * A BUFFERED FAILURE STILL RECORDS. `result.ok` is false when the enqueue
   * itself was refused -- the buffer full, or the DO unreachable -- and that is
   * backpressure nobody else reports. The flush cannot: the rows never reached
   * it. Suppressing this is the one way this change could go quiet exactly when
   * it matters.
   */
  buffered = false,
  /**
   * This lane writes ONCE PER PASS, not once per batch of rows (#10826).
   *
   * The suppression above assumes the flush will record an honest verdict for
   * this lane later. That holds for a row lane, whose statements carry its
   * name -- and it is FALSE for the `-pass` and `-prune` sub-lanes, which share
   * the base lane's buffered runner and so never appear in the flush's own
   * per-lane tally. Nothing can ever write them again once buffering is on.
   *
   * Measured on production 2026-08-11: `neon:nominator-positions-prune` and
   * `neon:nominator-positions-pass` held a `stale` verdict from 10:23 UTC --
   * "prune did not land; tally withheld", from one Durable Object reset during
   * a deploy -- while `nominator_positions` itself wrote 123,057 rows at 11:30
   * and `neon:nominator-positions` went `ok`. The failure verdict outlived its
   * own recovery by eight hours and counting, and the lane alarm escalated over
   * it the whole time. A verdict that cannot be cleared is not a health signal.
   *
   * #10690's cost argument does not reach here: these fire once per PASS --
   * daily for the nominator lanes -- so recording them is ~4 rows a day against
   * the ~758/hr that argument was about.
   *
   * The verdict says ENQUEUED rather than landed, because that is what is true
   * at this point. If the flush then fails, it records `stale` for the base
   * lane and for `neon:buffer-flush`, so the failure still surfaces.
   */
  oncePerPass = false,
): Promise<boolean> {
  const key = `neon:${lane}`;
  const verdict: LaneVerdict = result.ok ? "ok" : "stale";
  if (buffered && result.ok && !oncePerPass) return true;
  if (!shouldWriteNeonWriteVerdict(lastWrittenVerdict.get(key), verdict, nowMs))
    // TRUE, not false. `false` is this function's word for "the verdict is NOT
    // on record", and a coalesced verdict IS on record -- an identical row
    // inside the window says the same thing. No caller reads the return today
    // (every call site awaits it bare), which is exactly why the value has to
    // be right now: the first one that does will be reading it as health.
    return true;
  const written = await recordLaneVerdict(db, {
    lane: key,
    verdict,
    age_ms: null,
    detail: result.ok
      ? // "enqueued" when it is enqueued. A buffered once-per-pass verdict
        // (see oncePerPass) is recorded before the flush runs, and saying
        // "in N statement(s)" there would claim Neon holds rows that are
        // still in the buffer -- the exact overclaim #10690 refused, which
        // this keeps refusing while still clearing the lane.
        buffered
        ? `${result.rows} row(s) enqueued in ${result.statements} statement(s)`
        : `${result.rows} row(s) in ${result.statements} statement(s)`
      : `${result.rows} row(s) written before failure: ${result.reason ?? "unknown"}`,
    checked_at: nowMs,
  });
  // Only a row that LANDED may suppress the next one. Recording the attempt
  // instead would let a database outage silence the lane for the whole window,
  // which is precisely the lane going quiet when it matters most.
  if (written) lastWrittenVerdict.set(key, { verdict, checkedAt: nowMs });
  return written;
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
  return parseLaneList(env?.NEON_DUAL_WRITE_LANES);
}

/** A comma list, empty on anything that is not one. Shared by all three Neon
 * flags so "unset", "empty string" and "trailing comma" cannot mean different
 * things depending on which stage of the cutover is reading them. */
function parseLaneList(raw: unknown): Set<string> {
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((lane) => lane.trim())
      .filter((lane) => lane.length > 0),
  );
}

// NEON_READ_LANES lived here: which lanes READ from Neon, as opposed to the
// write list above. It existed to keep two questions apart -- "is HYPERDRIVE
// bound" and "should this route read Neon" -- because conflating them once
// moved a read onto a store nothing had written to (#9704).
//
// Both questions had answers while D1 held the other copy. Since #10179 there
// is no other copy, so the second one collapses into the first and the flag
// could only ever refuse a read, never redirect it. Deleted in #10051 with
// the route map and the gate in workers/data-api.ts that consulted it.

/** Whether `lane` should mirror into Neon on this deployment. */
export function neonDualWriteEnabled(
  env: Record<string, unknown> | null | undefined,
  lane: string,
): boolean {
  return neonDualWriteLanes(env).has(lane);
}

/**
 * Tables whose ONLY home is Neon -- no D1 copy, no mirror, no reconciler.
 *
 * A FOURTH flag, and the one the other three are converging on. The existing
 * vocabulary all describes a table that lives in D1 and is being shadowed:
 * NEON_DUAL_WRITE_LANES said new writes also reach Neon, NEON_BACKFILL_LANES
 * that older ones do too, NEON_READ_LANES that reads are served from the copy.
 * Every one of them presumed a D1 original still exists, which is why the last
 * two are already gone.
 *
 * That vocabulary does not fit the tables that move by having their WRITER
 * repointed. The user-state tier is the worked example: ten tables, ~1,200
 * rows, every one of them written by a request handler rather than a lane, all
 * reached through a single runner-acquiring helper. There is nothing to
 * reconcile because there is no second producer, and mirroring them would mean
 * running two stores for a table whose entire content one statement can copy.
 * They move by copying once, flipping the runner, and never writing D1 again.
 *
 * So this flag means something the others cannot express: D1 is not behind
 * this table any more. It starts empty, gains a table when that table's copy
 * is verified, and when it holds every name D1 has, D1 is unbound.
 */
export function neonSoleStoreTables(
  env: Record<string, unknown> | null | undefined,
): Set<string> {
  return parseLaneList(env?.NEON_SOLE_STORE_TABLES);
}

/** Whether Neon is the only store behind `table` on this deployment. */
export function neonOwnsTable(
  env: Record<string, unknown> | null | undefined,
  table: string,
): boolean {
  return neonSoleStoreTables(env).has(table);
}

/**
 * `name`, if it is a bare SQL identifier -- otherwise a throw.
 *
 * Moved here when the reconciler was deleted (#10166): src/neon-prune.ts is the
 * surviving caller, and it already imports from this module.
 *
 * Every plan's table and column name is interpolated into SQL rather than
 * bound, because a placeholder cannot stand where an identifier goes. The
 * names are repo constants, not input, so this is a guard against a typo
 * rather than against an attacker -- but it is the line where that would
 * become a vulnerability rather than a bug.
 *
 * Throwing rather than escaping is deliberate. A plan naming something that is
 * not a bare identifier is a mistake in the plan, and the loud failure belongs
 * at the lane, not quoted into a query that then does something unintended.
 */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(name: string, what: string): string {
  if (!BARE_IDENTIFIER.test(name)) {
    throw new Error(
      `${what} is not a bare SQL identifier: ${JSON.stringify(name)}`,
    );
  }
  return name;
}
