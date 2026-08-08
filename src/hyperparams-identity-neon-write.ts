// The Neon write for subnet_hyperparams and account_identity (#10046).
//
// WHY THESE TWO NEEDED A MODULE AT ALL. Both families showed exact parity in
// Neon and looked ready to invert -- and neither handler had ever executed a
// Neon write. `grep -ci neon` over either returned 0; both end with "the D1
// write IS the sync". Their Neon copies exist because NEON_BACKFILL_LANES
// reconciles them on a cron, not because anything mirrors them.
//
// That distinction is the whole reason this exists. The neurons lane could
// invert (#10037) on a mirror that had been writing every pass for weeks, so
// skipping the D1 write was provably safe. Inverting these on reconciler
// parity would mean flipping to a code path with ZERO production evidence
// while simultaneously removing the D1 copy -- which is how a migration loses
// rows rather than moving them.
//
// TRANSITIONAL, AND TRACKED AS SUCH (#10051). This is a rung, not the
// destination: once these tables are in NEON_SOLE_STORE_TABLES the D1 write
// goes, and once every table has crossed, NEON_DUAL_WRITE_LANES and every
// mirror call site including this one get deleted. A reconciler or mirror that
// outlives the inversion is worse than dead code -- it would copy a frozen D1
// over live Neon rows, because it cannot tell the direction reversed.
import { laneHealthStore } from "./lane-health-store.ts";
import { SUBNET_HYPERPARAMS_INSERT_COLUMNS } from "./subnet-hyperparams.ts";
import { ACCOUNT_IDENTITY_INSERT_COLUMNS } from "./account-identity.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import {
  neonDualWriteEnabled,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";

// ---------------------------------------------------------------------------
// Moved here when D1 was deleted (#10170). These describe the TABLE -- its
// column list, its conflict key, its derivations -- not the store that used to
// hold it, and this module is now the only writer.
// ---------------------------------------------------------------------------

/**
 * Columns of `subnet_hyperparams_history` (minus its AUTOINCREMENT id): the
 * netuid/block_number/observed_at keying plus the 33 hyperparameter fields --
 * SUBNET_HYPERPARAMS_INSERT_COLUMNS with netuid (front) and
 * block_number/captured_at (back) stripped, exactly the derivation the
 * Postgres write path uses -- and the diff hash.
 */
export const SUBNET_HYPERPARAMS_HISTORY_COLUMNS = [
  "netuid",
  "block_number",
  "observed_at",
  ...SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1, -2),
  "hyperparams_hash",
];

export const ACCOUNT_IDENTITY_HISTORY_COLUMNS = [
  "account",
  "observed_at",
  ...IDENTITY_FIELDS,
  "identity_hash",
];

export const SUBNET_HYPERPARAMS_NEON_LANE = "subnet-hyperparams";
export const ACCOUNT_IDENTITY_NEON_LANE = "account-identity";

type Row = Record<string, unknown>;

/**
 * One family's two tables: the latest-only card and its append-only history.
 *
 * The history has NO freshness guard, unlike the card. A history row is
 * appended only when the hash changed, so a conflict on (key, observed_at)
 * means the same revision arriving twice -- and doing nothing is right. A
 * `captured_at <` guard there would compare a column the table does not have.
 */
interface FamilyPlan {
  lane: string;
  latest: { table: string; columns: readonly string[]; conflict: string[] };
  history: { table: string; columns: readonly string[]; conflict: string[] };
}

/**
 * Exported so a lane->table pairing can be DERIVED rather than restated
 * from the same constant the writer uses, rather than restate it. A lane the
 * flag can name but the watchdog has no pairing for is a mirror nothing
 * watches, and restating is how that happens.
 */
export const FAMILY_MIRROR_PLANS: Readonly<Record<string, FamilyPlan>> = {
  [SUBNET_HYPERPARAMS_NEON_LANE]: {
    lane: SUBNET_HYPERPARAMS_NEON_LANE,
    latest: {
      table: "subnet_hyperparams",
      columns: SUBNET_HYPERPARAMS_INSERT_COLUMNS,
      conflict: ["netuid"],
    },
    history: {
      table: "subnet_hyperparams_history",
      columns: SUBNET_HYPERPARAMS_HISTORY_COLUMNS,
      conflict: ["netuid", "observed_at"],
    },
  },
  [ACCOUNT_IDENTITY_NEON_LANE]: {
    lane: ACCOUNT_IDENTITY_NEON_LANE,
    latest: {
      table: "account_identity",
      columns: ACCOUNT_IDENTITY_INSERT_COLUMNS,
      conflict: ["account"],
    },
    history: {
      table: "account_identity_history",
      columns: ACCOUNT_IDENTITY_HISTORY_COLUMNS,
      conflict: ["account", "observed_at"],
    },
  },
};

export interface FamilyMirrorInput {
  /** The latest-only rows, already coerced -- booleans are real booleans by
   * the time they reach here, which is what Neon's BOOLEAN columns need. */
  rows: Row[];
  /** Rows this pass appends, in the history table's own column shape. */
  historyRows: Row[];
}

export interface FamilyMirrorDeps {
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

export interface FamilyMirrorOutcome {
  attempted: boolean;
  results: Record<string, NeonWriteResult>;
}

/**
 * Write one family into Neon. Never throws.
 *
 * While D1 is still authoritative, a Neon failure costs a lane verdict and
 * nothing a caller can see. Once the family is in NEON_SOLE_STORE_TABLES the
 * handler reads `results` and turns any failure into the request's failure --
 * that inversion lives at the call site, not here, so this function has one
 * behaviour rather than two.
 */
export async function mirrorFamilyToNeon(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  lane: string,
  input: FamilyMirrorInput,
  deps: FamilyMirrorDeps = {},
): Promise<FamilyMirrorOutcome> {
  const plan = FAMILY_MIRROR_PLANS[lane];
  // An unknown lane is a no-op rather than a throw: the flag is a free-text
  // list, and a typo there must not take down the D1 write this runs behind.
  if (!plan || !neonDualWriteEnabled(env, lane))
    return { attempted: false, results: {} };

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  const now = deps.now ?? Date.now;

  if (!sql) {
    // Enabled but unbound is a MISCONFIGURATION, not a quiet no-op: somebody
    // named the lane and the binding is missing.
    await recordNeonWriteVerdict(
      laneDb,
      lane,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
    );
    return { attempted: true, results: {} };
  }

  const results: Record<string, NeonWriteResult> = {};
  if (input.rows.length > 0) {
    results[plan.latest.table] = await writeRowsToNeon(
      sql,
      plan.latest.table,
      plan.latest.columns,
      input.rows,
      plan.latest.conflict,
      `${plan.latest.table}.captured_at < EXCLUDED.captured_at`,
    );
  }
  if (input.historyRows.length > 0) {
    results[plan.history.table] = await writeRowsToNeon(
      sql,
      plan.history.table,
      plan.history.columns,
      input.historyRows,
      plan.history.conflict,
      // No guard: see FamilyPlan. A conflict here is the same revision twice.
      undefined,
    );
  }
  await recordNeonWriteVerdict(laneDb, lane, summarise(results), now());
  return { attempted: true, results };
}

/** One verdict for the pair, because they are written by one pass and a
 * reader wants "did this pass land", not two half-answers. */
function summarise(results: Record<string, NeonWriteResult>): NeonWriteResult {
  const all = Object.values(results);
  if (all.length === 0)
    return { ok: true, rows: 0, statements: 0, reason: "nothing to write" };
  const failed = all.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    rows: all.reduce((n, r) => n + (r.rows ?? 0), 0),
    statements: all.reduce((n, r) => n + (r.statements ?? 0), 0),
    ...(failed.length > 0
      ? { reason: failed.map((r) => r.reason ?? "failed").join("; ") }
      : {}),
  };
}

/** Exported for the handler's sole-store branch: which tables failed, if any. */
export function failedTables(outcome: FamilyMirrorOutcome): string[] {
  return Object.entries(outcome.results)
    .filter(([, r]) => !r.ok)
    .map(([table]) => table);
}

export { recordLaneVerdict };
