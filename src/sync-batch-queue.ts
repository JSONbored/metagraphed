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
}

/** Lanes the consumer will accept. An allowlist here, unlike the deliberately
 * permissive lane field on the health sink, because this one WRITES: an
 * unrecognised lane means an unrecognised table, and guessing is worse than
 * dead-lettering. */
export const SYNC_BATCH_LANES = ["hotkey-alpha", "account-balances"] as const;

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
