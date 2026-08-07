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

import {
  neonDualWriteEnabled,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import { ACCOUNT_BALANCE_INSERT_COLUMNS } from "./account-balances-d1-write.ts";
import { HOTKEY_ALPHA_INSERT_COLUMNS } from "./hotkey-alpha-d1-write.ts";
import { VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS } from "./validator-nominator-summary.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import type { LaneHealthDb } from "./lane-health.ts";

interface LedgerPlan {
  table: string;
  columns: readonly string[];
  conflict: readonly string[];
}

/**
 * One plan per lane, keyed by the name used in NEON_DUAL_WRITE_LANES.
 *
 * The conflict keys match each table's PRIMARY KEY in Neon, created 2026-08-07
 * from D1's own DDL. An ON CONFLICT naming columns with no unique index behind
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
 * While dual-writing, D1 is the store every route reads, so a Neon failure
 * costs a mirror and a lane verdict and nothing a caller can see.
 */
export async function mirrorLedgerToNeon(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  lane: string,
  rows: Record<string, unknown>[],
  deps: LedgerMirrorDeps = {},
): Promise<{ attempted: boolean; result?: NeonWriteResult }> {
  const plan = LEDGER_MIRROR_PLANS[lane];
  // An unknown lane is a NO-OP rather than a throw, and deliberately so: the
  // flag is a free-text list, and a typo there must not take down the D1 write
  // this runs behind.
  if (!plan || !neonDualWriteEnabled(env, lane)) return { attempted: false };

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;

  if (!sql) {
    // Enabled but unbound is a misconfiguration, not silence.
    await recordNeonWriteVerdict(
      laneDb,
      lane,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
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
  );
  await recordNeonWriteVerdict(laneDb, lane, result, now());
  return { attempted: true, result };
}
