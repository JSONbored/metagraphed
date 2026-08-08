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

import { laneHealthStore } from "./lane-health-store.ts";
import {
  writePassTallyToNeon,
  type PassTallyInput,
} from "./pass-completeness.ts";
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
  /** The pass tally, SURFACED so an inverted caller can require it (#10109).
   * It was written but not reported, so once this lane is Neon's the request
   * could answer ok while nominator_positions_passes -- a table with no other
   * writer -- took nothing. A completeness ledger nobody can tell is empty is
   * worse than no ledger. */
  pass?: NeonWriteResult;
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
  input: {
    rows: Row[];
    coldkeyMaxCapturedAt: ReadonlyMap<string, number>;
    /** This chunk's completeness tally (#10056). Written last, and only when
     * both the upsert and the prune succeeded -- see below. */
    pass?: PassTallyInput | null;
  },
  deps: NominatorPositionsMirrorDeps = {},
): Promise<NominatorPositionsMirrorOutcome> {
  if (!neonDualWriteEnabled(env, NOMINATOR_POSITIONS_NEON_LANE)) {
    return { attempted: false };
  }

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
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

  // AFTER THE PRUNE, not just after the upsert. This lane's pass is only
  // whole once the stale rows are gone: a tally written between the two would
  // declare a complete pass over a table that still holds superseded
  // positions, which is the state the prune exists to end.
  let passResult: NeonWriteResult | undefined;
  if (input.pass) {
    const tally = prune.ok
      ? await writePassTallyToNeon(
          sql,
          NOMINATOR_POSITIONS_NEON_LANE,
          input.pass,
        )
      : { ok: false, reason: "prune did not land; tally withheld" };
    passResult = {
      ok: tally.ok,
      rows: tally.ok ? 1 : 0,
      statements: 1,
      ...(tally.reason ? { reason: tally.reason } : {}),
    };
    await recordNeonWriteVerdict(
      laneDb,
      `${NOMINATOR_POSITIONS_NEON_LANE}-pass`,
      {
        ok: tally.ok,
        rows: tally.ok ? 1 : 0,
        statements: 1,
        ...(tally.reason ? { reason: tally.reason } : {}),
      },
      now(),
    );
  }
  return { attempted: true, write, prune, pass: passResult };
}

/**
 * Per-coldkey max captured_at for one batch -- the prune's cutoff map.
 *
 * Moved here from the deleted D1 writer (#10131): it never touched a database,
 * and it feeds the NEON prune, so it outlived the file it happened to live in.
 *
 * Pure and exported so the handler can build it without a database and the
 * test can assert the "later capture wins" rule directly. Rows whose coldkey
 * or captured_at is unusable are skipped rather than seeding a cutoff of NaN,
 * which would delete every row for that coldkey.
 */
export function coldkeyMaxCapturedAt(rows: Row[]): Map<string, number> {
  const cutoffs = new Map<string, number>();
  for (const row of rows) {
    const coldkey = typeof row?.coldkey === "string" ? row.coldkey : null;
    const capturedAt = row?.captured_at;
    if (!coldkey || !Number.isFinite(capturedAt as number)) continue;
    const current = cutoffs.get(coldkey);
    if (current == null || (capturedAt as number) > current) {
      cutoffs.set(coldkey, capturedAt as number);
    }
  }
  return cutoffs;
}
