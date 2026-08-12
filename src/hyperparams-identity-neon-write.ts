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
import {
  ACCOUNT_IDENTITY_INSERT_COLUMNS,
  IDENTITY_FIELDS,
} from "./account-identity.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { type HyperdriveLike, type WaitUntilLike } from "./pg-sql.ts";
import {
  neonWriteBufferEnabled,
  neonWriteRunner,
} from "./neon-write-buffer.ts";
import {
  pruneCardOutsideKeySet,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";

// ---------------------------------------------------------------------------
// Moved here when D1 was deleted (#10179). These describe the TABLE -- its
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
export const SUBNET_IDENTITY_NEON_LANE = "subnet-identity";
export const SUBNET_OWNERSHIP_NEON_LANE = "subnet-ownership";

/**
 * subnet_ownership and subnet_ownership_history -- the SAME four columns.
 *
 * Unlike every other family here the history takes no separate shape: it does
 * not rename the timestamp (0024 calls it `captured_at` in both tables) and it
 * carries no hash, because the owner pair IS the revision. One constant rather
 * than two identical ones, so a column added to the card cannot silently miss
 * the history.
 */
export const SUBNET_OWNERSHIP_COLUMNS = [
  "netuid",
  "owner_hotkey",
  "owner_coldkey",
  "captured_at",
];

/**
 * The identity fields a SUBNET declares on chain (SubnetIdentitiesV3).
 *
 * Deliberately NOT the account IDENTITY_FIELDS: a subnet has `symbol` and no
 * `additional`, and reusing the account list would silently write nulls into a
 * column the producer never sends and drop one it does.
 */
export const SUBNET_IDENTITY_FIELDS = [
  "subnet_name",
  "symbol",
  "description",
  "github_repo",
  "subnet_url",
  "discord",
  "logo_url",
] as const;

/** subnet_identity, the latest-only card. */
export const SUBNET_IDENTITY_INSERT_COLUMNS = [
  "netuid",
  "block_number",
  "captured_at",
  ...SUBNET_IDENTITY_FIELDS,
  "identity_hash",
];

/** subnet_identity_history, the append-on-change revisions. `observed_at`
 * rather than `captured_at`, matching the column the reader pages on. */
export const SUBNET_IDENTITY_HISTORY_COLUMNS = [
  "netuid",
  "block_number",
  "observed_at",
  ...SUBNET_IDENTITY_FIELDS,
  "identity_hash",
];

type Row = Record<string, unknown>;

/**
 * One family's two tables: the latest-only card and its append-only history.
 *
 * THE TWO GUARDS POINT IN OPPOSITE DIRECTIONS, and that is the point. The card
 * keeps the NEWEST observation (`captured_at < EXCLUDED.captured_at`); a
 * history row records when a revision was FIRST seen, so it keeps the OLDEST.
 *
 * A history whose conflict key CONTAINS its timestamp -- `(netuid,
 * observed_at)`, `(account, observed_at)` -- needs no guard at all: a conflict
 * there is the identical row arriving twice, and the update is a no-op. Those
 * plans leave `guard` unset and nothing changes for them.
 *
 * A history keyed on CONTENT instead -- `(netuid, identity_hash)` -- does need
 * one, and its absence was a live bug (#10836). The producer re-reads the whole
 * set every pass, so the same revision arrives hourly at a new timestamp;
 * `buildPgUpsert` emits `DO UPDATE SET ... observed_at = EXCLUDED.observed_at`
 * whenever a non-key column exists, so every unchanged identity had its
 * first-seen rewritten to last-seen on every pass. Measured on production
 * before the fix: 125 rows across 7 landed passes, and 124 of them sat at the
 * single newest pass -- an append-on-change table reporting a mass identity
 * change every hour, which is what /chain/identity-history was serving.
 *
 * The guard is `>` rather than DO NOTHING deliberately: an EARLIER observation
 * (a backfill) still moves the row back, because that is a better first-seen.
 * Only a later one is refused.
 */
interface FamilyPlan {
  lane: string;
  latest: { table: string; columns: readonly string[]; conflict: string[] };
  history: {
    table: string;
    columns: readonly string[];
    conflict: string[];
    /** Appended to the history's `DO UPDATE`. Omit when the conflict key
     * already contains the timestamp -- see above. */
    guard?: string;
  };
  /**
   * Delete card rows whose key this pass did not carry.
   *
   * ONLY VALID when the producer posts the entire population in ONE request,
   * which is why it is opt-in per family rather than the default. Set for
   * `subnet-ownership` (129 rows, one POST, a deregistered subnet must leave
   * the card) and unset for the rest -- `account-identity` posts in chunks,
   * and pruning against one chunk would delete the accounts in the others.
   */
  prune?: { keyColumn: string };
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
  [SUBNET_IDENTITY_NEON_LANE]: {
    lane: SUBNET_IDENTITY_NEON_LANE,
    latest: {
      table: "subnet_identity",
      columns: SUBNET_IDENTITY_INSERT_COLUMNS,
      conflict: ["netuid"],
    },
    history: {
      table: "subnet_identity_history",
      // (netuid, identity_hash), NOT (netuid, observed_at) like its siblings.
      // The producer re-reads the whole identity set every pass, so the same
      // revision arrives again and again at DIFFERENT observed_at values --
      // conflicting on the timestamp would append a duplicate row every pass
      // and turn the provenance this table exists for into noise. The hash is
      // what identifies a revision, and 0021's unique index enforces it.
      conflict: ["netuid", "identity_hash"],
      columns: SUBNET_IDENTITY_HISTORY_COLUMNS,
      // Keep the FIRST observation of this revision. Without this the hourly
      // re-send rewrote observed_at every pass -- see FamilyPlan.
      guard: "subnet_identity_history.observed_at > EXCLUDED.observed_at",
    },
  },
  [SUBNET_OWNERSHIP_NEON_LANE]: {
    lane: SUBNET_OWNERSHIP_NEON_LANE,
    latest: {
      table: "subnet_ownership",
      columns: SUBNET_OWNERSHIP_COLUMNS,
      conflict: ["netuid"],
    },
    history: {
      table: "subnet_ownership_history",
      columns: SUBNET_OWNERSHIP_COLUMNS,
      // CONTENT-KEYED, like subnet_identity_history and for the same reason:
      // the producer re-reads every owner every 300s, so conflicting on the
      // timestamp would append a duplicate row twelve times an hour. There is
      // no hash to key on because the owner pair is itself the content --
      // 0026's unique index is what enforces it.
      //
      // This REPLACES a diff the producer used to do in Rust: it SELECTed the
      // whole card, compared each resolved owner, and only INSERTed on a
      // change. That read-then-write cannot move to a Worker unchanged -- it
      // is a race between concurrent passes -- so the constraint does it.
      conflict: ["netuid", "owner_hotkey", "owner_coldkey"],
      guard: "subnet_ownership_history.captured_at > EXCLUDED.captured_at",
    },
    // Replaces the producer's own `DELETE FROM subnet_ownership WHERE netuid
    // <> ALL($1)`. The history is append-only and never pruned -- a subnet
    // that deregisters loses its card, not its trail.
    prune: { keyColumn: "netuid" },
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
  /**
   * The COMPLETE set of card keys this pass observed, for a plan that prunes.
   *
   * Distinct from `rows` on purpose: it is the caller's assertion that the set
   * is exhaustive, which `rows` alone cannot express -- a chunked producer
   * also has rows. Omitted, nothing is pruned.
   */
  pruneKeys?: readonly number[];
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
  // An unknown lane stays a no-op rather than a throw: callers name lanes in
  // code now (#10051 deleted the free-text flag), and a name this table lacks
  // is a config defect for lane_health to surface, not a crash.
  if (!plan) return { attempted: false, results: {} };
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
    // Enabled but unbound is a MISCONFIGURATION, not a quiet no-op: somebody
    // named the lane and the binding is missing.
    await recordNeonWriteVerdict(
      laneDb,
      lane,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
      buffered,
    );
    // ... and the miss is IN-BAND now (#10051): with the dual-write gate gone
    // this arm is the only "not durable" left, and returning empty results
    // let a sync route ack a write nothing held -- the false ok its own
    // comment warns advances the producer's resume head past unpersisted
    // blocks. Every table the plan would have written reports the failure.
    const results: Record<string, NeonWriteResult> = {};
    for (const table of [
      plan.latest.table,
      ...(plan.history ? [plan.history.table] : []),
    ]) {
      results[table] = {
        ok: false,
        rows: 0,
        statements: 0,
        reason: "hyperdrive unbound",
      };
    }
    return { attempted: true, results };
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
  // AFTER the card upsert and only if it landed, matching the order the Rust
  // producer used and for its stated reason: upsert-before-prune means an
  // active subnet is never even transiently missing from the card. Pruning
  // against a pass whose upsert failed would delete rows whose replacements
  // were never written.
  if (plan.prune && input.pruneKeys && results[plan.latest.table]?.ok !== false)
    results[`${plan.latest.table}:prune`] = await pruneCardOutsideKeySet(
      sql,
      plan.latest.table,
      plan.prune.keyColumn,
      input.pruneKeys,
    );
  if (input.historyRows.length > 0) {
    results[plan.history.table] = await writeRowsToNeon(
      sql,
      plan.history.table,
      plan.history.columns,
      input.historyRows,
      plan.history.conflict,
      // Set only for content-keyed histories, which must keep the FIRST
      // observation rather than the latest. See FamilyPlan.
      plan.history.guard,
    );
  }
  await recordNeonWriteVerdict(
    laneDb,
    lane,
    summarise(results),
    now(),
    buffered,
  );
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
