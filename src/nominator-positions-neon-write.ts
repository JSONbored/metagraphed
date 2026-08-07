// The nominator-positions lane's Neon mirror (metagraphed-infra#336).
//
// TWO CALL SITES, BOTH MIRRORED, and that is the point rather than an
// implementation detail. #9728 was one unmirrored writer -- the neuron-daily
// backfill route -- leaving `account_position_daily` 92 rows short in Neon
// while the row count looked nearly right. This lane also has two writers (the
// sync handler and the queue consumer), so both call this or the mirror is a
// lie the moment traffic takes the other path.
//
// ## The prune is what makes this lane different
//
// `nominator_positions` is a LATEST-ONLY ledger: a position that no longer
// exists must be deleted, not left behind. A full Alpha scan is ~153,611 rows,
// far past one request body, so the lane posts in several requests -- and a
// batch-wide "delete everything older than this pass" sweep would let one
// request delete the rows another just wrote.
//
// So the cutoff is PER COLDKEY, against that coldkey's own max captured_at,
// exactly as writeNominatorPositionsToD1 computes it. It rests on the same
// poster contract the D1 side does: one coldkey's positions are never split
// across two requests.
//
// The prune runs AFTER the upsert, and its failure is reported separately. The
// worst a failure can do in that order is leave a stale position until the next
// tick -- never delete a position without having written its replacement first.

import {
  neonDualWriteEnabled,
  pruneKeysInNeon,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import { NOMINATOR_POSITION_INSERT_COLUMNS } from "./account-nominator-positions.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import type { LaneHealthDb } from "./lane-health.ts";

/** The lane name this mirror answers to in NEON_DUAL_WRITE_LANES. */
export const NOMINATOR_POSITIONS_NEON_LANE = "nominator-positions";

/** Matches nominator_positions_pkey in Neon, created 2026-08-07. An ON CONFLICT
 * naming columns with no unique index behind them is a runtime error. */
export const NOMINATOR_POSITIONS_CONFLICT = [
  "coldkey",
  "hotkey",
  "netuid",
] as const;

type Row = Record<string, unknown>;

export interface NominatorPositionsMirrorOutcome {
  attempted: boolean;
  write?: NeonWriteResult;
  prune?: NeonWriteResult;
}

export interface NominatorPositionsMirrorDeps {
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

/**
 * Mirror one nominator-positions batch into Neon. Never throws.
 *
 * Called from BOTH writers. While dual-writing, D1 is the store every route
 * reads, so a Neon failure costs a mirror and a lane verdict and nothing else.
 */
export async function mirrorNominatorPositionsToNeon(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  input: { rows: Row[]; coldkeyMaxCapturedAt: ReadonlyMap<string, number> },
  deps: NominatorPositionsMirrorDeps = {},
): Promise<NominatorPositionsMirrorOutcome> {
  if (!neonDualWriteEnabled(env, NOMINATOR_POSITIONS_NEON_LANE)) {
    return { attempted: false };
  }

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  const laneDb =
    deps.laneHealthDb ?? (env?.METAGRAPH_HEALTH_DB as LaneHealthDb | undefined);
  const now = deps.now ?? Date.now;

  if (!sql) {
    // Enabled but unbound is a misconfiguration, not a quiet no-op.
    const failure = {
      ok: false,
      rows: 0,
      statements: 0,
      reason: "hyperdrive unbound",
    };
    await recordNeonWriteVerdict(
      laneDb,
      NOMINATOR_POSITIONS_NEON_LANE,
      failure,
      now(),
    );
    return { attempted: true };
  }

  const write = await writeRowsToNeon(
    sql,
    "nominator_positions",
    NOMINATOR_POSITION_INSERT_COLUMNS,
    input.rows,
    NOMINATOR_POSITIONS_CONFLICT,
    // An older capture arriving after a newer one must be a no-op. This lane
    // retries, so an out-of-order arrival is a real event.
    "nominator_positions.captured_at < EXCLUDED.captured_at",
  );
  await recordNeonWriteVerdict(
    laneDb,
    NOMINATOR_POSITIONS_NEON_LANE,
    write,
    now(),
  );

  // THE PRUNE IS SKIPPED WHEN THE UPSERT FAILED, and that ordering is load
  // bearing rather than tidy. Pruning against a batch whose rows did not land
  // would delete live positions and leave nothing in their place; no retry
  // undoes a delete.
  if (!write.ok) return { attempted: true, write };

  const prune = await pruneKeysInNeon(
    sql,
    "nominator_positions",
    "coldkey",
    input.coldkeyMaxCapturedAt,
  );
  await recordNeonWriteVerdict(
    laneDb,
    `${NOMINATOR_POSITIONS_NEON_LANE}-prune`,
    prune,
    now(),
  );
  return { attempted: true, write, prune };
}
