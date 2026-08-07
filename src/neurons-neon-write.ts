// The neurons lane's Neon mirror (metagraphed-infra#336).
//
// Three tables move together because ONE handler produces all three:
// `handleNeuronsSync` parses the posted metagraph into `neurons`, then derives
// `neuron_daily` and `account_position_daily` from it. Mirroring at that point
// costs one extra pass over rows already in memory, and mirroring anywhere else
// would mean re-deriving them.
//
// ## The ordering is the point
//
// This runs AFTER the D1 write returns, never instead of it and never in front
// of it. The pilot broke by doing the opposite -- a read moved to Neon while
// nothing wrote to it, so `GET /api/v1/accounts/{ss58}/subnets/{netuid}/history`
// served a two-day-old snapshot until metagraphed#9705 unbound Hyperdrive.
//
// While dual-writing, D1 is still the store every route reads. So a Neon
// failure must cost a mirror and a lane verdict, and nothing else. Nothing here
// throws.
//
// ## What makes the eventual read-cutover safe
//
// A lane verdict on EVERY attempt. metagraphed#9698's reader turns a Neon store
// that stops accepting writes into a GitHub issue within the hour -- which is
// the check that did not exist when a frozen database was serving the public
// API. Do not move a read onto a table here until its `neon:` lane has been
// green across several producer ticks.

import {
  neonDualWriteEnabled,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
} from "./neurons-d1-write.ts";
import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import type { LaneHealthDb } from "./lane-health.ts";

/** The lane name this mirror answers to in NEON_DUAL_WRITE_LANES. */
export const NEURONS_NEON_LANE = "neurons";

type Row = Record<string, unknown>;

/**
 * One table's mirror plan: where the rows go, in what column order, and on
 * what key they collide.
 *
 * The conflict keys match Neon's own primary keys, read off the live database
 * rather than assumed -- `neurons_pkey (netuid, uid)` and
 * `account_position_daily_pkey (account, netuid, snapshot_date)`. An ON CONFLICT
 * naming columns without a matching unique index is a runtime error, not a
 * slower query.
 */
interface MirrorPlan {
  table: string;
  columns: readonly string[];
  conflict: readonly string[];
  guard?: string;
}

export const NEURON_MIRROR_PLANS: Readonly<Record<string, MirrorPlan>> = {
  neurons: {
    table: "neurons",
    columns: NEURON_INSERT_COLUMNS,
    conflict: ["netuid", "uid"],
    // The out-of-order protection D1's own upsert applies. A retried chunk can
    // arrive after a newer pass, and without this it would overwrite fresher
    // rows with older ones -- silently, since both writes succeed.
    guard: "neurons.captured_at < EXCLUDED.captured_at",
  },
  neuron_daily: {
    table: "neuron_daily",
    columns: NEURON_DAILY_COLUMNS,
    conflict: ["netuid", "uid", "snapshot_date"],
  },
  account_position_daily: {
    table: "account_position_daily",
    columns: ACCOUNT_POSITION_DAILY_COLUMNS,
    conflict: ["account", "netuid", "snapshot_date"],
  },
};

export interface NeuronMirrorInput {
  rows: Row[];
  dailyRows: Row[];
  positionRows: Row[];
}

export interface NeuronMirrorOutcome {
  /** False when the lane is not enabled, or Hyperdrive is unbound. Distinct
   * from a failed attempt: "we did not try" is not "we tried and it broke". */
  attempted: boolean;
  results: Record<string, NeonWriteResult>;
}

export interface NeuronMirrorDeps {
  /** Injectable runner, so a test asserts the statements without a database. */
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

/**
 * Mirror one snapshot into Neon. Never throws.
 *
 * The three writes run in sequence rather than in parallel: they share one
 * Hyperdrive connection, and `neurons` is the table a read would move to first,
 * so it goes first and a failure below it still leaves the most important table
 * current.
 */
export async function mirrorNeuronSnapshotToNeon(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  input: NeuronMirrorInput,
  deps: NeuronMirrorDeps = {},
): Promise<NeuronMirrorOutcome> {
  const empty: NeuronMirrorOutcome = { attempted: false, results: {} };
  if (!neonDualWriteEnabled(env, NEURONS_NEON_LANE)) return empty;

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  // Enabled but unbound is a MISCONFIGURATION, not a quiet no-op: somebody
  // named the lane and the binding is missing, and that deserves a verdict
  // rather than silence. It is recorded under the lane so #9698 reports it.
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;
  if (!sql) {
    await recordNeonWriteVerdict(
      laneDb,
      NEURONS_NEON_LANE,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
    );
    return { attempted: true, results: {} };
  }

  // Keyed by the same names as NEURON_MIRROR_PLANS, so the loop below indexes
  // it without a fallback -- a `?? []` there would silently mirror nothing if
  // the two ever drifted apart, which is the opposite of what should happen.
  const byTable: Record<keyof typeof NEURON_MIRROR_PLANS, Row[]> = {
    neurons: input.rows,
    neuron_daily: input.dailyRows,
    account_position_daily: input.positionRows,
  };
  const results: Record<string, NeonWriteResult> = {};
  for (const [name, plan] of Object.entries(NEURON_MIRROR_PLANS)) {
    const result = await writeRowsToNeon(
      sql,
      plan.table,
      plan.columns,
      byTable[name],
      plan.conflict,
      plan.guard,
    );
    results[name] = result;
    await recordNeonWriteVerdict(laneDb, name, result, now());
  }
  return { attempted: true, results };
}
