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
// This runs AFTER the store write returns, never instead of it and never in front
// of it. The pilot broke by doing the opposite -- a read moved to Neon while
// nothing wrote to it, so `GET /api/v1/accounts/{ss58}/subnets/{netuid}/history`
// served a two-day-old snapshot until metagraphed#9705 unbound Hyperdrive.
//
// Neon is now the store every route reads, so a snapshot that did not land
// here did not land at all. Nothing here throws even so: the outcome is
// reported back and the call site decides, which is where the pass-level
// verdict belongs.
//
// ## What makes the eventual read-cutover safe
//
// A lane verdict on EVERY attempt. metagraphed#9698's reader turns a Neon store
// that stops accepting writes into a GitHub issue within the hour -- which is
// the check that did not exist when a frozen database was serving the public
// API. Do not move a read onto a table here until its `neon:` lane has been
// green across several producer ticks.

import { laneHealthStore } from "./lane-health-store.ts";
import {
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";
import { type HyperdriveLike, type WaitUntilLike } from "./pg-sql.ts";
import {
  neonWriteBufferEnabled,
  neonWriteRunner,
} from "./neon-write-buffer.ts";
import type { LaneHealthDb } from "./lane-health.ts";
import {
  writePassTallyToNeon,
  type PassTallyInput,
} from "./pass-completeness.ts";
import type { NeonWriteEnv } from "./neon-write-buffer.ts";

// ---------------------------------------------------------------------------
// Moved here when D1 was deleted (#10179). These describe the TABLE -- its
// column list, its conflict key, its derivations -- not the store that used to
// hold it, and this module is now the only writer.
// ---------------------------------------------------------------------------

export const NEURON_DAILY_COLUMNS = [
  ...NEURON_INSERT_COLUMNS,
  "snapshot_date",
  "updated_at",
];

export const ACCOUNT_POSITION_DAILY_COLUMNS = [
  "account",
  "netuid",
  "snapshot_date",
  "uid",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "incentive",
  "dividends",
  "stake_tao",
  "emission_tao",
  "captured_at",
  "updated_at",
];

/** The UTC day a capture belongs to. */
/**
 * The floor below which a value is not epoch MILLISECONDS.
 *
 * 1e12 is 2001-09-09. Every real capture is far above it, and every
 * seconds-valued timestamp this decade is far below (2026 in seconds is ~1.79e9),
 * so the two populations are separated by three orders of magnitude with nothing
 * legitimate in between. A bound rather than a digit count because that is the
 * question actually being asked: is this plausibly a millisecond stamp.
 */
export const EPOCH_MS_FLOOR = 1e12;

/** Whether `value` is plausibly an epoch-millisecond stamp. */
export function isEpochMillis(value: unknown): value is number {
  return (
    Number.isFinite(value as number) && (value as number) >= EPOCH_MS_FLOOR
  );
}

/**
 * The day a capture belongs to, or null if its stamp is not milliseconds.
 *
 * RETURNS NULL RATHER THAN A DATE, because the failure it guards against is
 * silent by construction. `new Date(1785715160)` is a perfectly good Date --
 * 1970-01-21 -- so a seconds-valued stamp does not throw, does not warn, and
 * produces a row keyed under a date fifty-six years in the past. One such row
 * exists in account_position_daily today (#9782): its `updated_at` is correct
 * milliseconds and its `captured_at` is the same instant with the last three
 * digits gone, so the two disagree by exactly 1000.
 *
 * It is one row, and the reason to guard rather than only repair is that it
 * put `account_position_daily`'s date range at `1970-01-21 .. 2026-08-07`,
 * outside every served window and inside every COUNT(*).
 */
// Takes `unknown`, matching its own guard: `isEpochMillis` is a type
// predicate over `unknown` and `Number.isFinite` does not coerce, so a
// numeric STRING is rejected here and always was. Declaring the parameter
// `number` said the caller had already checked, which no caller had (#10782).
export function neuronSnapshotDate(capturedAtMs: unknown): string | null {
  if (!isEpochMillis(capturedAtMs)) return null;
  return new Date(capturedAtMs).toISOString().slice(0, 10);
}

// --- The three derivations, pure and shared ---------------------------------
//
// `neuron_daily` and `account_position_daily` are pure functions of the posted
// rows, and the prune cutoff is a pure function of them too. They used to be
// computed inline in the sync handler, which was fine while the handler was the
// only writer. It is not any more: the queue consumer receives a message that
// carries `rows` and nothing else (metagraphed-infra#359 is the standing reason
// SyncBatchMessage stays one array), so it has to redo all three.
//
// Two implementations of a prune cutoff is two chances to compute a different
// one, and the failure mode there is deleted rows. So there is one.

/**
 * Per-netuid max `captured_at`, the cutoff the snapshot write prunes on.
 *
 * NOT one batch-wide value: a global max would let one netuid's later capture
 * delete rows this same write just upserted for a different, earlier-captured
 * netuid -- its own fresh rows would satisfy `captured_at < max`.
 *
 * Rows with an unusable netuid or captured_at are skipped rather than seeding a
 * NaN cutoff, which would delete every row for that netuid. Same rule, and the
 * same reason, as `coldkeyMaxCapturedAt` in the positions lane.
 */
export function netuidMaxCapturedAt(rows: Row[]): Map<number, number> {
  const cutoffs = new Map<number, number>();
  for (const row of rows) {
    const netuid = row?.netuid;
    const capturedAt = row?.captured_at;
    if (!Number.isFinite(netuid as number)) continue;
    // The same bound as the snapshot date, and for a sharper reason: this map
    // is the PRUNE cutoff. A seconds-valued stamp here is a cutoff below every
    // real row, which deletes nothing -- but a stray LARGE value would delete
    // the netuid, so the pair is checked as one question rather than two.
    if (!isEpochMillis(capturedAt)) continue;
    const current = cutoffs.get(netuid as number);
    if (current == null || (capturedAt as number) > current) {
      cutoffs.set(netuid as number, capturedAt as number);
    }
  }
  return cutoffs;
}

/**
 * `neuron_daily` rows: the posted row plus its day and a write stamp.
 *
 * A row whose `captured_at` is not milliseconds is DROPPED rather than written
 * under whatever date it derives to. Dropping loses one row; writing it puts a
 * permanent 1970 entry in an append-only table, where it is outside every
 * served window and inside every aggregate -- and no later pass revises it,
 * because the key it landed under is one nothing else will ever write.
 */
export function neuronDailyRows(rows: Row[], nowMs: number): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const snapshotDate = neuronSnapshotDate(row.captured_at as number);
    if (snapshotDate === null) continue;
    out.push({ ...row, snapshot_date: snapshotDate, updated_at: nowMs });
  }
  return out;
}

/**
 * `account_position_daily` rows, re-keyed by account.
 *
 * Rows with no hotkey are dropped: the table is keyed on `account`, so a null
 * one has nowhere to go.
 */
export function neuronPositionRows(dailyRows: Row[]): Row[] {
  return dailyRows
    .filter((row) => row.hotkey != null)
    .map((row) => ({
      account: row.hotkey,
      netuid: row.netuid,
      snapshot_date: row.snapshot_date,
      uid: row.uid,
      coldkey: row.coldkey,
      active: row.active,
      validator_permit: row.validator_permit,
      rank: row.rank,
      trust: row.trust,
      incentive: row.incentive,
      dividends: row.dividends,
      stake_tao: row.stake_tao,
      emission_tao: row.emission_tao,
      captured_at: row.captured_at,
      updated_at: row.updated_at,
    }));
}

/** Everything a snapshot write needs, derived from the rows alone -- so the
 * sync handler and the queue consumer build it the same way. */
export interface NeuronSnapshotWrite {
  rows: Row[];
  dailyRows: Row[];
  positionRows: Row[];
  /** Per-netuid max captured_at -- NOT one batch-wide value. */
  netuidMaxCapturedAt: Map<number, number>;
}

export function neuronSnapshotWrite(
  rows: Row[],
  nowMs: number,
): NeuronSnapshotWrite {
  const dailyRows = neuronDailyRows(rows, nowMs);
  return {
    rows,
    dailyRows,
    positionRows: neuronPositionRows(dailyRows),
    netuidMaxCapturedAt: netuidMaxCapturedAt(rows),
  };
}

/** The lane name this writer files its `lane_health` verdict under (`neon:<lane>`). */
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
    // The out-of-order protection the store's own upsert applies. A retried chunk can
    // arrive after a newer pass, and without this it would overwrite fresher
    // rows with older ones -- silently, since both writes succeed.
    guard: "neurons.captured_at < EXCLUDED.captured_at",
  },
  // THE DAILY TABLES CARRY THE GUARD TOO (#10184), and the reasoning that said
  // they did not need one was half right.
  //
  // It went: these are keyed by snapshot_date, so a late arrival lands on its
  // own day and cannot collide with a fresher row. That holds ACROSS days and
  // fails WITHIN one -- handleNeuronDailyBackfill replays past snapshot_dates,
  // and a replay whose range overlaps TODAY shares today's snapshot_date while
  // carrying an older captured_at. Without the guard it wins, and the route's
  // own header promises the opposite: "a backfill re-POST can never clobber a
  // fresher row".
  //
  // the store's buildJsonUpsert appended `captured_at <= excluded.captured_at` to
  // every one of the three unconditionally. This restores that.
  neuron_daily: {
    table: "neuron_daily",
    columns: NEURON_DAILY_COLUMNS,
    conflict: ["netuid", "uid", "snapshot_date"],
    guard: "neuron_daily.captured_at < EXCLUDED.captured_at",
  },
  account_position_daily: {
    table: "account_position_daily",
    columns: ACCOUNT_POSITION_DAILY_COLUMNS,
    conflict: ["account", "netuid", "snapshot_date"],
    guard: "account_position_daily.captured_at < EXCLUDED.captured_at",
  },
};

export interface NeuronMirrorInput {
  rows: Row[];
  dailyRows: Row[];
  positionRows: Row[];
  /** This chunk's completeness tally, when the producer declared a pass.
   *
   * Carried here rather than written by the caller because of the invariant
   * src/neurons-d1-write.ts states for the D1 side: the tally must not be able
   * to report a pass complete whose rows never landed. D1 gets that from one
   * atomic batch. Postgres cannot, because writeRowsToNeon chunks -- so it is
   * enforced below instead, by writing the tally ONLY after every table
   * succeeded. */
  pass?: PassTallyInput | null;
  /**
   * Per-netuid max `captured_at`, which the prune below deletes beneath.
   *
   * Optional because the backfill route legitimately has none: it walks PAST
   * snapshot_dates and must never touch `neurons`, so it passes `rows: []` and
   * omits this. Absent means "do not prune", never "prune everything".
   */
  netuidMaxCapturedAt?: Map<number, number> | null;
}

/**
 * Delete each netuid's rows older than that netuid's newest capture.
 *
 * ONE STATEMENT for the whole map rather than one per netuid: a full pass
 * covers ~129 subnets, and 129 round trips on a Hyperdrive connection is the
 * kind of cost that turns a prune into a timeout. The pairs travel as two
 * parallel arrays and are joined with `unnest`, so nothing is interpolated into
 * the text and the parameter count is 2 regardless of how many netuids there
 * are.
 *
 * Never throws -- it reports like every other write here, because a failed
 * prune must not fail a pass whose rows landed.
 */
export async function pruneNeuronsToCapture(
  sql: { unsafe(text: string, values?: unknown[]): Promise<unknown> },
  cutoffs: ReadonlyMap<number, number>,
): Promise<NeonWriteResult> {
  const netuids: number[] = [];
  const capturedAt: number[] = [];
  for (const [netuid, at] of cutoffs) {
    // Re-checked here rather than trusted: a NaN cutoff would delete every row
    // for that netuid, which is the one outcome this function must not have.
    if (!Number.isFinite(netuid) || !Number.isFinite(at)) continue;
    netuids.push(netuid);
    capturedAt.push(at);
  }
  if (netuids.length === 0) {
    return { ok: true, rows: 0, statements: 0 };
  }
  try {
    await sql.unsafe(
      "DELETE FROM neurons n USING unnest($1::int[], $2::bigint[])" +
        " AS cutoff(netuid, captured_at)" +
        " WHERE n.netuid = cutoff.netuid AND n.captured_at < cutoff.captured_at",
      [netuids, capturedAt],
    );
    return { ok: true, rows: 0, statements: 1 };
  } catch (error) {
    return {
      ok: false,
      rows: 0,
      statements: 1,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface NeuronMirrorOutcome {
  /** False when the lane is not enabled, or Hyperdrive is unbound. Distinct
   * from a failed attempt: "we did not try" is not "we tried and it broke". */
  attempted: boolean;
  results: Record<string, NeonWriteResult>;
  /** The deregistration prune, kept OUT of `results` on purpose -- see the
   * write path. Absent when there were no cutoffs to prune on, or when a table
   * failed and the prune was withheld. */
  prune?: NeonWriteResult;
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
  env: NeonWriteEnv | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  input: NeuronMirrorInput,
  deps: NeuronMirrorDeps = {},
): Promise<NeuronMirrorOutcome> {
  // The dual-write gate stood here until #10051: with D1 deleted this is the
  // SOLE write to the ONLY store, so it runs unconditionally -- a flag whose
  // no-arm means "do not persist" is not a cutover control any more, it is an
  // off switch nothing should be holding.
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  // #10659: buffered when the lane is flagged, direct otherwise. Defaults OFF
  // (empty lane list), so this changes nothing until a lane is named.
  const sql =
    deps.sql ?? neonWriteRunner(env, ctx, NEURONS_NEON_LANE, hyperdrive);
  // Enabled but unbound is a MISCONFIGURATION, not a quiet no-op: somebody
  // named the lane and the binding is missing, and that deserves a verdict
  // rather than silence. It is recorded under the lane so #9698 reports it.
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  // #10690: a buffered SUCCESS records no verdict here -- the flush owns the
  // honest per-lane one. A buffered FAILURE still does: that is the enqueue
  // being refused, which nothing else reports. Only a runner we BUILT counts,
  // since an injected deps.sql went wherever the caller pointed it.
  const buffered = !deps.sql && neonWriteBufferEnabled(env, NEURONS_NEON_LANE);
  const now = deps.now ?? Date.now;
  if (!sql) {
    await recordNeonWriteVerdict(
      laneDb,
      NEURONS_NEON_LANE,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
      buffered,
    );
    // ... and the miss is IN-BAND now (#10051): with the dual-write gate gone
    // this arm is the only "not durable" left, and empty results let a sync
    // route ack a write nothing held. Every plan reports the failure instead.
    const unbound: Record<string, NeonWriteResult> = {};
    for (const name of Object.keys(NEURON_MIRROR_PLANS)) {
      unbound[name] = {
        ok: false,
        rows: 0,
        statements: 0,
        reason: "hyperdrive unbound",
      };
    }
    return { attempted: true, results: unbound };
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
    // The derived tables are SUB-LANES of the buffered runner (#10888): every
    // statement here rides under the ONE lane tag the runner was built with,
    // NEURONS_NEON_LANE, so the flush can only ever file `neon:neurons` --
    // `neon:neuron_daily` and `neon:account_position_daily` never appear in
    // its per-lane tally under any key. Suppressing their buffered successes
    // on the flush's behalf therefore silenced them permanently the moment
    // the buffer came on (#10758): 30 hours of "neon:neuron_daily is silent"
    // alarms, measured 2026-08-12, while the table held that day's snapshot.
    // oncePerPass is #10826's remedy for exactly this shape, and the cost
    // argument holds at this cadence too: two extra verdict rows per 15-minute
    // pass. The base lane stays flush-attributed -- its statements DO carry
    // its name.
    await recordNeonWriteVerdict(
      laneDb,
      name,
      result,
      now(),
      buffered,
      name !== NEURONS_NEON_LANE,
    );
  }

  // THE DEREGISTRATION PRUNE (#10184). the store's writer ran this and the Neon mirror
  // never did, so a UID that leaves a subnet stayed in `neurons` forever.
  //
  // PER NETUID, never one batch-wide cutoff. A global max would let one
  // netuid's later capture delete rows this same write just upserted for a
  // different, earlier-captured netuid -- its own fresh rows would satisfy
  // `captured_at < max`. netuidMaxCapturedAt is computed from the posted rows
  // for exactly this reason, and computed ONCE so the writer and the prune
  // cannot disagree about the cutoff.
  //
  // AFTER the upserts, never before: the rows this pass carries have to be in
  // before anything is deleted beneath them, or a failure between the two
  // leaves the netuid short.
  //
  // ONLY when every table landed. A prune on top of a failed upsert deletes the
  // old rows without the new ones replacing them, which turns a retryable write
  // failure into missing data. Skipping costs one tick of stale UIDs; the next
  // pass prunes them.
  //
  // Benign today and permanent tomorrow, which is why it is worth restoring
  // now: every pass currently rewrites every UID under one shared captured_at,
  // so Neon holds 0 stale rows (verified 2026-08-08). It stops being benign the
  // first time a subnet shrinks its UID count or is deregistered.
  //
  // REPORTED BESIDE `results`, NEVER INSIDE IT. The callers fold over
  // `results` to decide whether the request failed, so putting the prune there
  // would 502 a pass whose rows all landed -- and the producer would re-send a
  // snapshot that is already stored. The rows are the valuable half; stale UIDs
  // cost one tick. Its own lane verdict is how it stays visible.
  const cutoffs = input.netuidMaxCapturedAt;
  let prune: NeonWriteResult | undefined;
  if (cutoffs?.size && Object.values(results).every((r) => r.ok)) {
    prune = await pruneNeuronsToCapture(sql, cutoffs);
    await recordNeonWriteVerdict(
      laneDb,
      `${NEURONS_NEON_LANE}-prune`,
      prune,
      now(),
      buffered,
      // ONCE PER PASS (#10826), and this argument has been dropped once
      // already. #10908 added it here; #10917 removed it four hours later
      // while rewriting the surrounding read handles, and production's last
      // `neon:neurons-prune` verdict is dated 2026-08-12T22:33 -- the deploy
      // that carried it. The lane then read `unknown` for five days while the
      // prune ran correctly every pass (0 stale rows in `neurons`, measured
      // 2026-08-17), because a buffered success records nothing unless this
      // says the lane cannot be recorded by anything else.
      //
      // It cannot: this sub-lane's statements ride under the base lane's tag,
      // so the flush's per-lane tally never names it. The suppression in
      // recordNeonWriteVerdict is sound only for lanes the flush will speak
      // for later, and no flush will ever speak for this one.
      true,
    );
  }

  // THE TALLY GOES LAST, AND ONLY IF EVERY TABLE LANDED (#10056).
  //
  // This is the Postgres form of the ordering src/neurons-d1-write.ts gets for
  // free by appending the tally to its batch. A pass marked complete whose rows
  // did not land is the one failure this ledger exists to make impossible, so a
  // partial write must leave the tally alone: the next chunk re-sends its rows
  // and the pass completes then, whereas a tally written over missing rows is
  // never revisited.
  if (input.pass) {
    const rowsLanded = Object.values(results).every((r) => r.ok);
    const tally = rowsLanded
      ? await writePassTallyToNeon(sql, NEURONS_NEON_LANE, input.pass)
      : { ok: false, reason: "rows did not land; tally withheld" };
    const verdict: NeonWriteResult = {
      ok: tally.ok,
      rows: tally.ok ? 1 : 0,
      statements: 1,
      ...(tally.reason ? { reason: tally.reason } : {}),
    };
    // Its OWN lane name, not the snapshot's: a tally that failed while the
    // three tables landed is a different fault from a table failing, and
    // folding them into one verdict would hide whichever came second.
    await recordNeonWriteVerdict(
      laneDb,
      `${NEURONS_NEON_LANE}-pass`,
      verdict,
      now(),
      buffered,
      // ONCE PER PASS -- see the prune's note above, which this lane shares
      // verbatim: same buffered runner, same missing flush attribution, same
      // five days of `unknown` while `neurons_passes` took a row every pass.
      true,
    );
    results[`${NEURONS_NEON_LANE}_passes`] = verdict;
  }
  return { attempted: true, results, ...(prune ? { prune } : {}) };
}
