// The three flat ledgers' Neon mirror (metagraphed-infra#336).
//
// `account_balances`, `hotkey_alpha` and `validator_nominator_counts` share one
// module because they share one shape: a natural key, a handful of value
// columns, and a `captured_at`. No prune, no derived siblings, no second table
// computed from the same body. They are the simplest tables left on the list,
// and giving each its own file would be three copies of the same twelve lines.
//
// ## Each has TWO writers, and both mirror
//
// #9728 was ONE unmirrored writer -- the neuron-daily backfill route -- leaving
// `account_position_daily` 92 rows short in Neon while the row count looked
// nearly right. Every table here writes from an inline sync branch AND from the
// sync-batches queue consumer, so both call this. A mirror covering one of two
// is a lie the moment traffic takes the other.
//
// ## No prune, and that is a property of the data rather than an omission
//
// Unlike `nominator_positions`, none of these is a latest-only ledger whose
// absent rows must be deleted. An account that stops holding TAO keeps a row
// with a zero balance; a hotkey that leaves a subnet keeps its last reading
// with an ageing `captured_at`. The readers over them already treat staleness
// as the signal, so a delete would remove information rather than correct it.
//
// The out-of-order guard still applies to all three: these lanes retry, and a
// retried chunk arriving after a newer pass must be a no-op rather than a
// silent regression -- both writes would otherwise succeed.

import { laneHealthStore } from "./lane-health-store.ts";
import {
  PASS_TABLES,
  writePassTallyToNeon,
  type PassTallyInput,
} from "./pass-completeness.ts";
import {
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import { VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS } from "./validator-nominator-summary.ts";
import { type HyperdriveLike, type WaitUntilLike } from "./pg-sql.ts";
import {
  neonWriteBufferEnabled,
  neonWriteRunner,
} from "./neon-write-buffer.ts";
import type { LaneHealthDb } from "./lane-health.ts";

// ---------------------------------------------------------------------------
// Moved here when D1 was deleted (#10179). These describe the TABLE -- its
// column list, its conflict key, its derivations -- not the store that used to
// hold it, and this module is now the only writer.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Moved here when D1 was deleted (#10179). These describe the TABLE -- its
// column list, its conflict key, its derivations -- not the store that used to
// hold it, and this module is now the only writer.
// ---------------------------------------------------------------------------

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

interface LedgerPlan {
  table: string;
  columns: readonly string[];
  conflict: readonly string[];
  /** A SQL predicate rows must satisfy to be inserted, over the `src` alias
   * buildPgUpsert gives the VALUES list. Present only where the store writer
   * filters too -- a mirror that stores MORE than its source is a mirror in
   * name only (#9832). */
  filter?: string;
  /**
   * Target types for the columns the FILTERED form selects (#10121).
   *
   * Only the filtered form needs them: `FROM (VALUES ...) AS src (...)` is a
   * standalone relation whose columns have no declared types, so every untyped
   * parameter falls back to TEXT and the insert fails against any non-text
   * column. The unfiltered form takes its types from the target columns.
   */
  columnTypes?: Readonly<Record<string, string>>;
}

/**
 * One plan per lane, keyed by the lane's `lane_health` name.
 *
 * The conflict keys match each table's PRIMARY KEY in Neon, created 2026-08-07
 * from the store's own DDL. An ON CONFLICT naming columns with no unique index behind
 * them is a runtime error, not a slower query.
 */
export const LEDGER_MIRROR_PLANS: Readonly<Record<string, LedgerPlan>> = {
  "account-balances": {
    table: "account_balances",
    columns: ACCOUNT_BALANCE_INSERT_COLUMNS,
    conflict: ["ss58"],
  },
  "hotkey-alpha": {
    table: "hotkey_alpha",
    columns: HOTKEY_ALPHA_INSERT_COLUMNS,
    conflict: ["hotkey", "netuid"],
    // THE FILTER D1 HAS HAD SINCE #9558, finally on this side too.
    //
    // D1 stored only pools a `nominator_positions` row references, because
    // `TotalHotkeyAlpha` has ~762,577 entries and the positions name ~17,900
    // -- the other 43x is "written every pass, read by nothing" and saturated
    // D1 outright. The mirror never had the predicate, so Neon accumulated
    // 47,320 rows against the store's 17,867 (#9832).
    //
    // Postgres spelling of the same EXISTS the store writer passes to
    // chunkStatements; `src` is the alias buildPgUpsert gives the VALUES list.
    //
    // `::int` IS LOad BEARING, and its absence broke this lane outright. A
    // bare parameter inside a `VALUES` list has no type context, so Postgres
    // resolves every one of `src`'s columns to TEXT. `np.hotkey = src.hotkey`
    // is text = text and passes; `np.netuid = src.netuid` is `integer = text`
    // and there is no such operator, so the whole statement throws before a
    // single row is written.
    //
    // Measured, not inferred: lane_health has `neon:hotkey-alpha` reporting
    // `0 row(s) written before failure: operator does not exist: integer =
    // text` on every pass since this filter shipped. The lane did not degrade,
    // it stopped -- and `neon-parity` read the resulting divergence as the
    // KNOWN one this filter was added to fix, which is why it looked like
    // progress.
    //
    // Cast on the src side rather than the column side: `np.netuid::text`
    // would also typecheck and would silently discard the index on
    // nominator_positions.
    filter:
      "EXISTS (SELECT 1 FROM nominator_positions np" +
      " WHERE np.hotkey = src.hotkey AND np.netuid = src.netuid::int)",
    // EVERY non-text column, not just the one the error happened to name.
    // Postgres reports the FIRST mismatch, so fixing them one error at a time
    // is three deploys; hotkey is text on both sides and needs no cast.
    columnTypes: {
      netuid: "int",
      total_alpha: "double precision",
      captured_at: "bigint",
    },
  },
  "validator-nominator-counts": {
    table: "validator_nominator_counts",
    columns: VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
    conflict: ["hotkey"],
  },
};

export interface LedgerMirrorDeps {
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

/**
 * Mirror one ledger batch into Neon. Never throws.
 *
 * Never throwing is about the BOUNDARY, not about the write being optional:
 * Neon is the store every route reads, so a batch that did not land here did
 * not land at all. The result is returned rather than raised so each caller
 * decides -- and they all treat `ok: false` as a failed pass (502), which is
 * what the name "mirror" no longer implies.
 */
export async function mirrorLedgerToNeon(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  lane: string,
  rows: Record<string, unknown>[],
  deps: LedgerMirrorDeps = {},
  /** This chunk's completeness tally, when the producer declared a pass and
   * the lane has a table in PASS_TABLES (#10056).
   *
   * A SIXTH PARAMETER rather than a field on `deps`, because deps is for
   * injectables a test swaps out and this is data the producer sent. Optional,
   * so the lanes with no pass table call this exactly as before. */
  pass?: PassTallyInput | null,
): Promise<{ attempted: boolean; result?: NeonWriteResult }> {
  const plan = LEDGER_MIRROR_PLANS[lane];
  // An unknown lane stays a NO-OP rather than a throw: callers name lanes in
  // code now (#10051 deleted the free-text flag), but a caller passing a name
  // this table lacks is still a config defect to surface via lane_health, not
  // a reason to crash the pass around it.
  if (!plan) return { attempted: false };
  // The dual-write gate stood here until #10051: with D1 deleted this is the
  // SOLE write to the ONLY store, so it runs unconditionally -- a flag whose
  // no-arm means "do not persist" is not a cutover control any more, it is an
  // off switch nothing should be holding.

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  // #10659: buffered when the lane is flagged, direct otherwise. Defaults OFF
  // (empty lane list), so this changes nothing until a lane is named.
  const sql = deps.sql ?? neonWriteRunner(env, ctx, lane, hyperdrive);
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  // #10690: a buffered SUCCESS records no verdict here -- the flush owns the
  // honest per-lane one. A buffered FAILURE still does: that is the enqueue
  // being refused, which nothing else reports. Only a runner we BUILT counts,
  // since an injected deps.sql went wherever the caller pointed it.
  const buffered = !deps.sql && neonWriteBufferEnabled(env, lane);
  const now = deps.now ?? Date.now;

  if (!sql) {
    // Enabled but unbound is a misconfiguration, not silence.
    await recordNeonWriteVerdict(
      laneDb,
      lane,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
      buffered,
    );
    return { attempted: true };
  }

  const result = await writeRowsToNeon(
    sql,
    plan.table,
    plan.columns,
    rows,
    plan.conflict,
    `${plan.table}.captured_at < EXCLUDED.captured_at`,
    plan.filter,
    plan.columnTypes,
  );
  await recordNeonWriteVerdict(laneDb, lane, result, now(), buffered);

  // THE TALLY GOES LAST, AND ONLY IF THE ROWS LANDED (#10056).
  //
  // D1 gets this ordering free by appending the tally to the same batch. Here
  // it is explicit: a pass marked complete whose rows did not land is the one
  // failure this ledger exists to make impossible, and it is never revisited,
  // whereas withholding it costs nothing because the next chunk re-sends.
  if (pass && PASS_TABLES[lane]) {
    const tally = result.ok
      ? await writePassTallyToNeon(sql, lane, pass)
      : { ok: false, reason: "rows did not land; tally withheld" };
    await recordNeonWriteVerdict(
      laneDb,
      `${lane}-pass`,
      {
        ok: tally.ok,
        rows: tally.ok ? 1 : 0,
        statements: 1,
        ...(tally.reason ? { reason: tally.reason } : {}),
      },
      now(),
      buffered,
      // ONCE PER PASS (#10826): this sub-lane shares the base lane's buffered
      // runner, so the flush's per-lane tally never names it -- a suppressed
      // success here can never be recorded by anything else, and a `stale`
      // verdict then outlives its own recovery. Measured on
      // neon:validator-nominator-counts-pass, stale from 10:15 UTC while its
      // table wrote 112,250 rows at 11:30.
      true,
    );
  }
  return { attempted: true, result };
}
