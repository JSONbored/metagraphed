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
// exactly as writeNominatorPositionsToStore computes it. It rests on the same
// poster contract the D1 side does: one coldkey's positions are never split
// across two requests.
//
// The prune runs AFTER the upsert, and its failure is reported separately. The
// worst a failure can do in that order is leave a stale position until the next
// tick -- never delete a position without having written its replacement first.

import { laneHealthStore } from "./lane-health-store.ts";
import { normalizeShareFractionsInNeon } from "./neon-write.ts";
import {
  writePassTallyToNeon,
  type PassTallyInput,
} from "./pass-completeness.ts";
import {
  pruneKeysInNeon,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import { NOMINATOR_POSITION_INSERT_COLUMNS } from "./account-nominator-positions.ts";
import { type HyperdriveLike, type WaitUntilLike } from "./pg-sql.ts";
import {
  neonWriteBufferEnabled,
  neonWriteRunner,
} from "./neon-write-buffer.ts";
import type { LaneHealthDb } from "./lane-health.ts";
import type { NeonWriteEnv } from "./neon-write-buffer.ts";

/** The lane name this writer files its `lane_health` verdict under (`neon:<lane>`). */
export const NOMINATOR_POSITIONS_NEON_LANE = "nominator-positions";

/** The lane `self-stake` reports under -- its own, not this one's. */
export const SELF_STAKE_NEON_LANE = "self-stake";

/**
 * `nominator_positions.source` values (#10845).
 *
 * The column exists so two producers can share the table without one's prune
 * deleting the other's rows. ALPHA is the default 0027 backfilled onto every
 * existing row, so nothing that predates the column changes behaviour.
 */
export const POSITION_SOURCE_ALPHA = "alpha";
export const POSITION_SOURCE_SELF_STAKE = "self-stake";

/** The wire columns plus the one the WRITER stamps. Derived rather than
 * restated, so a column added to the route's shape reaches the INSERT. */
export const POSITION_INSERT_COLUMNS_WITH_SOURCE = [
  ...NOMINATOR_POSITION_INSERT_COLUMNS,
  "source",
];

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
 * Called from BOTH writers. Neon is the store every route reads, so a batch
 * that did not land here did not land at all -- the failure is returned, not
 * raised, and both callers turn it into the request's failure.
 */
export async function mirrorNominatorPositionsToNeon(
  env: (NeonWriteEnv & { METAGRAPH_HEALTH_DB?: unknown }) | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  input: {
    rows: Row[];
    coldkeyMaxCapturedAt: ReadonlyMap<string, number>;
    /** This chunk's completeness tally (#10056). Written last, and only when
     * both the upsert and the prune succeeded -- see below. */
    pass?: PassTallyInput | null;
    /**
     * Which producer wrote these rows, and therefore which rows the prune may
     * delete (#10845). Defaults to the Alpha scan, so every existing caller is
     * unchanged and every existing row -- all 123,057 of them, defaulted by
     * 0027 -- keeps matching.
     */
    source?: string;
    /**
     * The lane these rows report under. `self-stake` is a DIFFERENT lane from
     * `nominator-positions` even though both write this table: they run on
     * different cadences (weekly vs daily) and a shared verdict would let one
     * lane's silence hide behind the other's success.
     */
    lane?: string;
  },
  deps: NominatorPositionsMirrorDeps = {},
): Promise<NominatorPositionsMirrorOutcome> {
  const lane = input.lane ?? NOMINATOR_POSITIONS_NEON_LANE;
  const source = input.source ?? POSITION_SOURCE_ALPHA;
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
    // Enabled but unbound is a misconfiguration, not a quiet no-op.
    const failure = {
      ok: false,
      rows: 0,
      statements: 0,
      reason: "hyperdrive unbound",
    };
    await recordNeonWriteVerdict(laneDb, lane, failure, now(), buffered);
    // The miss is IN-BAND too (#10051): with the dual-write gate gone this is
    // the only "not durable" left, and an outcome carrying no parts slipped
    // past the sync route's `[write, prune, pass].filter(r => r && !r.ok)`
    // guard -- an unbound store 200-acked, and the producer's resume head
    // moved past rows nothing held. The write slot reports the failure.
    return { attempted: true, write: failure };
  }

  // `source` is STAMPED HERE, never taken from the wire. A producer that could
  // name its own source could claim another lane's prune domain and delete its
  // rows -- so the column is set from the call site's constant, and the route's
  // schema rejects `source` as an unknown column if a producer sends one.
  const write = await writeRowsToNeon(
    sql,
    "nominator_positions",
    POSITION_INSERT_COLUMNS_WITH_SOURCE,
    input.rows.map((row) => ({ ...row, source })),
    NOMINATOR_POSITIONS_CONFLICT,
    // An older capture arriving after a newer one must be a no-op. This lane
    // retries, so an out-of-order arrival is a real event.
    "nominator_positions.captured_at < EXCLUDED.captured_at",
  );
  await recordNeonWriteVerdict(laneDb, lane, write, now(), buffered);

  // THE PRUNE IS SKIPPED WHEN THE UPSERT FAILED, and that ordering is load
  // bearing rather than tidy. Pruning against a batch whose rows did not land
  // would delete live positions and leave nothing in their place; no retry
  // undoes a delete.
  if (!write.ok) return { attempted: true, write };

  // SCOPED TO THIS PRODUCER'S ROWS (#10845). Unscoped, a validator-nominators
  // pass would delete the self-stake rows for any coldkey it touched -- those
  // rows are absent from the Alpha scan by construction, so they are always
  // "older than this pass" and always deleted.
  const prune = await pruneKeysInNeon(
    sql,
    "nominator_positions",
    "coldkey",
    input.coldkeyMaxCapturedAt,
    source,
  );
  await recordNeonWriteVerdict(
    laneDb,
    `${lane}-prune`,
    prune,
    now(),
    buffered,
    // ONCE PER PASS (#10826): this sub-lane shares the base lane's buffered
    // runner, so the flush's per-lane tally never names it and a suppressed
    // success here can never be recorded by anything else.
    true,
  );

  // AFTER THE PRUNE, BEFORE THE TALLY (metagraphed-infra#414). Recomputes
  // share_fraction from the raw shares of this pass, which is what lets the
  // producer stop buffering the whole keyspace to compute a pool-normalised
  // value it cannot derive one row at a time.
  //
  // The ordering is the same argument the tally below makes: normalising while
  // superseded rows are still present would divide by a denominator that
  // includes them. So it runs after the prune, and the tally -- which declares
  // the pass whole -- runs after this.
  //
  // NOT FATAL, and deliberately unlike the prune. A failure here leaves the
  // fraction the producer computed in place, which is the value this lane has
  // always served; the rows are correct, just not re-derived. Failing the pass
  // over it would trade a served-and-correct table for no pass at all. It rides
  // on the same lane verdict so a persistent failure is still visible.
  //
  // A no-op until the poller sends shares: the statement matches no rows.
  if (prune.ok && input.pass?.capturedAt) {
    const normalized = await normalizeShareFractionsInNeon(
      sql,
      Number(input.pass.capturedAt),
    );
    await recordNeonWriteVerdict(
      laneDb,
      `${NOMINATOR_POSITIONS_NEON_LANE}-normalize`,
      normalized,
      now(),
      buffered,
      // ONCE PER PASS, same reason as the prune and the tally: this sub-lane
      // shares the base lane's buffered runner, so the flush never names it and
      // a suppressed success could never be cleared (#10830).
      true,
    );
  }

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
      buffered,
      // ONCE PER PASS (#10826) -- see the prune's own note.
      true,
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
