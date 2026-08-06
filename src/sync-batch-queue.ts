// The bulk sync path, on a queue (metagraphed-infra#346/#347).
//
// WHAT THIS REPLACES, and why it is a refactor rather than a rescue. Each bulk
// lane grew its own substitute for what a queue provides: a retry loop with
// hand-tuned backoff, a one-second inter-chunk sleep standing in for
// backpressure, a declared `pass_total` standing in for "did the batch set
// drain", and a publish floor standing in for "was the scan even complete".
// Every one was a correct local fix for the D1 saturation on 2026-08-05 --
// `D1_ERROR: D1 DB is overloaded. Requests queued for too long.`, which aborted
// the passes and also failed `wallet-auth` and `tao-usd-index` on the database
// everything shares. Together they are an orchestration layer nobody designed.
//
// All of that machinery currently WORKS -- five consecutive complete
// account-balances passes, a complete hotkey-alpha pass, the top-holders
// columns live. So this replaces working code, which is exactly why it goes one
// lane at a time behind a producer-side switch.
//
// NO DUAL WRITE. A lane enqueues OR posts, never both. Writing everything twice
// during the migration doubles the load that caused the incident, and duplicate
// arrivals corrupt the completeness tally -- `received_rows` counted against a
// declared `pass_total` is what caught a ledger publishing 147,000 of 364,000
// rows while looking perfectly fresh.
//
// WHAT THE QUEUE DOES NOT GIVE, and must not be deleted along with the
// scaffolding it does replace:
//
//   * PASS COMPLETENESS. A queue knows a message was delivered. It does not
//     know whether a producer's whole SCAN arrived, which is a different fact
//     and the one that stopped a wrong leaderboard publishing.
//   * THE PUBLISH FLOOR. A truncated scan is a producer-side fact the queue
//     never sees at all.
//
// Both survive this migration deliberately. See metagraphed-infra#352.

/** One chunk of a lane's pass, as producers enqueue it. */
export interface SyncBatchMessage {
  /** Which lane produced it -- `hotkey-alpha`, `account-balances`, … */
  lane: string;
  /** The pass this chunk belongs to, stamped once by the producer at scan
   * start and repeated across every chunk. The completeness contract keys on
   * it, exactly as the HTTP path's `captured_at` does. */
  captured_at: number;
  /** How many rows the WHOLE pass will deliver. Optional for the same reason
   * it is optional on the sync routes: a producer may post without declaring,
   * and inventing a total would mark an unproven load complete. */
  pass_total?: number;
  rows: Record<string, unknown>[];
  /**
   * "Every row for each KEY named in this message is IN this message."
   *
   * Only a pruning lane needs it, and only because its write DELETES: the
   * writer removes rows for a key older than the newest `captured_at` it just
   * saw for that key. Computed from a partial chunk, that would delete rows the
   * chunk simply did not carry -- silent data loss, not a slowdown.
   *
   * WHICH key is the lane's own business -- `nominator-positions` prunes per
   * `coldkey`, `neurons` per netuid -- so the flag is deliberately named for
   * the property rather than for the column. A per-column field would have to
   * be renamed the moment the second pruning lane moved, and renaming a wire
   * field after cutover is not free.
   *
   * The producer's `pack_coldkey_chunks` already guarantees it, and has a test
   * that a flat slice would fail. But once the write moves to a consumer, that
   * guarantee is load-bearing across a repo boundary, and an assumption that
   * crosses a boundary should be an assertion. Absent, the consumer refuses to
   * prune rather than pruning on trust.
   */
  key_complete?: boolean;
}

/**
 * Lanes the consumer will accept.
 *
 * AN ALLOWLIST, unlike the deliberately permissive lane field on the health
 * sink, because this one WRITES: an unrecognised lane means an unrecognised
 * table, and guessing is worse than dead-lettering.
 *
 * EVERY BULK LANE BELONGS HERE EVENTUALLY, not just the two that broke. The D1
 * saturation was never one lane's doing -- it is the SUM of every sync route
 * writing unthrottled, and `neurons` alone writes ~30k rows every 15 minutes
 * through the same path. One queue with one concurrency limit is what turns
 * that into global backpressure; a lane left out is a lane that can still
 * overwhelm the database the others are being polite about.
 *
 * They are cut over ONE AT A TIME regardless (see SYNC_QUEUE_LANES), so this
 * list is what the consumer can accept, not what is currently routed.
 */
export const SYNC_BATCH_LANES = [
  "hotkey-alpha",
  "account-balances",
  "neurons",
  "nominator-positions",
  "validator-nominator-counts",
  "account-identity",
  "chain-detail",
  "subnet-hyperparams",
] as const;

/**
 * Lanes whose write PRUNES, and therefore may not be applied from a chunk that
 * could be missing rows for a key it names.
 *
 * `neurons` belongs here too -- it prunes per netuid -- but is not on the queue
 * yet, and listing a lane before its producer asserts completeness would reject
 * every one of its messages. It joins when it moves.
 */
export const PRUNING_LANES: readonly string[] = ["nominator-positions"];

export type SyncBatchLane = (typeof SYNC_BATCH_LANES)[number];

/** Rows per message. Sized against the sink's existing per-request ceiling
 * rather than re-derived: the D1 write shape is unchanged by the transport, and
 * `json_each` already made a chunk one statement (metagraphed#9550). */
export const SYNC_BATCH_MAX_ROWS = 5_000;

/**
 * Validate one message off the queue.
 *
 * A malformed message is NOT retried -- retrying a message that can never parse
 * burns the retry budget and then dead-letters anyway, five attempts later. The
 * caller acks it and records it instead, so the DLQ holds things that might yet
 * succeed rather than things that never could.
 */
export function validSyncBatchMessage(body: unknown): body is SyncBatchMessage {
  const m = body as SyncBatchMessage | null;
  if (!m || typeof m !== "object") return false;
  if (!SYNC_BATCH_LANES.includes(m.lane as SyncBatchLane)) return false;
  if (
    typeof m.captured_at !== "number" ||
    !Number.isInteger(m.captured_at) ||
    m.captured_at <= 0
  ) {
    return false;
  }
  if (
    m.pass_total !== undefined &&
    (!Number.isInteger(m.pass_total) || m.pass_total <= 0)
  ) {
    return false;
  }
  if (!Array.isArray(m.rows) || m.rows.length === 0) return false;
  // A pruning lane must SAY its chunk is key-complete. Refusing here beats
  // pruning on trust: the failure mode is deleted rows, which no retry undoes.
  if (PRUNING_LANES.includes(m.lane) && m.key_complete !== true) {
    return false;
  }
  if (m.rows.length > SYNC_BATCH_MAX_ROWS) return false;
  if (m.pass_total !== undefined && m.pass_total < m.rows.length) return false;
  return m.rows.every((r) => r !== null && typeof r === "object");
}

/** How a message was disposed of, so a batch's outcome is reportable rather
 * than inferred from an absence of errors. */
export interface SyncBatchOutcome {
  acked: number;
  /** Retried by the queue -- transient, may yet succeed. */
  retried: number;
  /** Acked despite failing, because retrying could not help. */
  rejected: number;
}

/**
 * Split a batch into what should be written, retried, and rejected.
 *
 * Pure, so the disposition rule is testable without a queue or a database --
 * and the rule is the part worth testing: "retry the transient, reject the
 * impossible" is what keeps a DLQ meaningful.
 */
export function classifySyncBatch(
  messages: readonly { readonly body: unknown }[],
): { valid: SyncBatchMessage[]; invalid: number } {
  const valid: SyncBatchMessage[] = [];
  let invalid = 0;
  for (const message of messages) {
    if (validSyncBatchMessage(message.body)) valid.push(message.body);
    else invalid += 1;
  }
  return { valid, invalid };
}

/**
 * Which lanes route through the queue rather than writing D1 inline.
 *
 * ONE PLACE DECIDES, and it is a per-lane env flag rather than a constant, so a
 * cutover and its rollback are both a deploy-time setting instead of a code
 * change. That matters because rollback needs to be boring: these are
 * latest-only upsert tables refreshed on a tick, so flipping back simply means
 * the next pass writes the old way -- no backfill, no reconciliation.
 *
 * NEVER BOTH. The flag SELECTS a path, it does not fan out. Dual-writing would
 * double the D1 load that caused the saturation this migration exists to fix,
 * and duplicate arrivals would corrupt the completeness tally that caught a
 * ledger publishing 147,000 of 364,000 rows while looking perfectly fresh.
 *
 * Absent flag means the old path, so a deployment that has not opted in behaves
 * exactly as before -- the same posture every other switch here takes.
 */
export function syncLaneUsesQueue(
  env: { SYNC_BATCHES?: unknown; SYNC_QUEUE_LANES?: string },
  lane: SyncBatchLane,
): boolean {
  if (!env.SYNC_BATCHES) return false;
  const enabled = (env.SYNC_QUEUE_LANES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return enabled.includes(lane);
}

/** The D1 surface the consumer writes through -- structural, so a test can hand
 * a plain object instead of standing up a binding. */
export type SyncBatchWriter = (
  rows: Record<string, unknown>[],
  pass: PassTally | null,
) => Promise<unknown>;

/** Lane -> its D1 writer. PARTIAL on purpose: a lane may be accepted by the
 * validator before its writer is wired, and writeSyncBatch throws rather than
 * silently skipping so a half-migrated lane fails loudly instead of leaving a
 * pass that never completes. */
export type SyncBatchWriters = Partial<Record<SyncBatchLane, SyncBatchWriter>>;

/** The completeness tally a chunk carries, when its producer declared one. */
export interface PassTally {
  capturedAt: number;
  expectedRows: number;
  receivedRows: number;
  nowMs: number;
}

/**
 * Turn one queue message into the write its lane needs.
 *
 * THE TALLY IS COMMUTATIVE, which is what makes this safe off a queue at all.
 * `received_rows` accumulates and `completed_at` is stamped by whichever write
 * closes the gap, so messages arriving out of order -- which a queue permits and
 * concurrency guarantees -- still land on the same answer. An accounting scheme
 * that depended on arrival order could not have moved here without changing its
 * meaning.
 */
export function passTallyFor(
  message: SyncBatchMessage,
  nowMs: number,
): PassTally | null {
  if (message.pass_total === undefined) return null;
  return {
    capturedAt: message.captured_at,
    expectedRows: message.pass_total,
    receivedRows: message.rows.length,
    nowMs,
  };
}

/** Dispatch one validated message to its lane's writer. Separated from the
 * Worker handler so the routing is testable without a queue. */
export async function writeSyncBatch(
  message: SyncBatchMessage,
  writers: SyncBatchWriters,
  nowMs: number = Date.now(),
): Promise<void> {
  const writer = writers[message.lane as SyncBatchLane];
  if (!writer) {
    // Unreachable given validSyncBatchMessage's allowlist, and thrown rather
    // than ignored: a silently skipped lane is a pass that never completes.
    throw new Error(`sync-batches: no writer for lane ${message.lane}`);
  }
  await writer(message.rows, passTallyFor(message, nowMs));
}
