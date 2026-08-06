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
 * `json_each` already made a chunk one statement (metagraphed#9550).
 *
 * THIS IS NOT THE BINDING LIMIT and never was -- see SYNC_BATCH_MAX_BYTES.
 * A row-count ceiling cannot bound a payload whose rows differ in size by lane,
 * and 5,000 hotkey-alpha rows is already 5x the transport's cap. It survives as
 * a cheap sanity bound on top of the byte budget, not as the thing that makes a
 * message deliverable. */
export const SYNC_BATCH_MAX_ROWS = 5_000;

/**
 * The transport's hard ceiling: a Cloudflare Queues message is capped at
 * **128 KB**, of which up to ~100 bytes is internal metadata.
 * https://developers.cloudflare.com/queues/platform/limits/
 */
export const QUEUE_MESSAGE_MAX_BYTES = 128 * 1024;

/**
 * The byte budget `packSyncBatchMessages` fills, deliberately under the cap.
 *
 * WHY A BYTE BUDGET AND NOT A ROW COUNT (metagraphed-infra#360). The route used
 * to hand `send()` the whole posted chunk, and the producers chunk at 25,000
 * rows. Measured against real `hotkey_alpha` rows at 127.6 bytes each, that is
 * 3,116 KB -- **24x over** -- so `send()` threw, the route returned 502, and the
 * producer read that as a transient network fault, retried six times and
 * abandoned the pass. A cut-over lane did not degrade; it stopped.
 *
 * Rows are not a proxy for bytes. `hotkey_alpha` carries a 48-character ss58 and
 * three scalars; `account_balances` and `nominator_positions` carry more. One
 * row count that is safe for the widest lane wastes most of the budget on the
 * narrowest, and one that suits the narrowest overflows on the widest. So the
 * packer measures.
 *
 * The headroom covers the envelope (`lane`, `captured_at`, `pass_total`,
 * `key_complete`, the array brackets and commas) plus the platform's own
 * metadata, and leaves room for a row slightly larger than any sampled -- a
 * subnet identity with a long description, say. Cheap insurance against a
 * failure whose signature is a stopped lane rather than an error.
 */
export const SYNC_BATCH_MAX_BYTES = 96 * 1024;

/**
 * Which column a pruning lane's write DELETES by, so the packer never splits
 * one key's rows across two messages.
 *
 * This is the packer's half of the `key_complete` contract. The consumer
 * refuses a pruning lane's message that does not assert key-completeness; this
 * is what makes the assertion true rather than merely claimed. A lane in
 * PRUNING_LANES with no entry here is a programming error and
 * `packSyncBatchMessages` throws rather than emitting an unsafe message -- the
 * failure it would otherwise cause is deleted rows, which no retry undoes.
 */
export const PRUNING_LANE_KEYS: Readonly<Record<string, string>> = {
  "nominator-positions": "coldkey",
  // `neurons` prunes per netuid and joins PRUNING_LANES when it moves
  // (metagraphed-infra#357); its key is declared here at the same time.
};

/** Bytes one row costs inside the `rows` array, including its separating
 * comma. Measured rather than estimated -- see SYNC_BATCH_MAX_BYTES. */
function rowBytes(row: Record<string, unknown>): number {
  return JSON.stringify(row).length + 1;
}

/**
 * Split one posted chunk into messages that each fit the transport.
 *
 * ONE POST BECOMES N MESSAGES, and the pass tally does not notice, because the
 * tally is commutative: `received_rows` accumulates and `completed_at` is
 * stamped by whichever write closes the gap. N messages summing to the same
 * rows land on the same answer as one message would have, in any order. That
 * property is what makes fanning out here safe without touching the producer,
 * the declared `pass_total`, or the publish floor.
 *
 * KEY-AWARE FOR PRUNING LANES. A lane whose write deletes rows for a key older
 * than the newest `captured_at` it saw for that key cannot be applied from a
 * message missing some of that key's rows -- it would delete rows the message
 * never carried. So for a pruning lane the packer groups by the lane's key and
 * places whole groups, never part of one. Every emitted message then genuinely
 * satisfies `key_complete`, which the consumer already refuses to take on trust.
 *
 * A single key whose rows exceed the budget THROWS rather than being split.
 * Splitting it would silently reintroduce exactly the deletion this guards, and
 * a coldkey needing more than 96 KB of positions is a fact worth surfacing
 * loudly rather than a case to quietly degrade.
 */
export function packSyncBatchMessages(input: {
  lane: SyncBatchLane;
  capturedAt: number;
  passTotal?: number;
  rows: Record<string, unknown>[];
  maxBytes?: number;
  maxRows?: number;
  /** Overridable so the "listed as pruning, no key declared" guard below is
   * reachable from a test. PRUNING_LANES and PRUNING_LANE_KEYS are deliberately
   * NOT one list -- a lane can have a known prune key while its producer does
   * not yet assert key-completeness, which is exactly `neurons` today -- so the
   * mismatch is possible and the guard is not decorative. */
  pruningKeys?: Readonly<Record<string, string>>;
}): SyncBatchMessage[] {
  const {
    lane,
    capturedAt,
    passTotal,
    rows,
    maxBytes = SYNC_BATCH_MAX_BYTES,
    maxRows = SYNC_BATCH_MAX_ROWS,
    pruningKeys = PRUNING_LANE_KEYS,
  } = input;
  if (rows.length === 0) return [];

  const prunes = PRUNING_LANES.includes(lane);
  const keyColumn = prunes ? pruningKeys[lane] : undefined;
  if (prunes && !keyColumn) {
    throw new Error(
      `sync-batches: ${lane} prunes but declares no key column; ` +
        `add it to PRUNING_LANE_KEYS before enqueuing`,
    );
  }

  // Groups the packer places atomically. For a non-pruning lane every row is
  // its own group, so the same code path handles both and there is no second
  // packing rule to keep in step with this one.
  const groups: Record<string, unknown>[][] = [];
  if (keyColumn) {
    const byKey = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const key = String(row[keyColumn]);
      const group = byKey.get(key);
      if (group) group.push(row);
      else byKey.set(key, [row]);
    }
    groups.push(...byKey.values());
  } else {
    for (const row of rows) groups.push([row]);
  }

  const messages: SyncBatchMessage[] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 0;

  // NEVER CALLED EMPTY, and deliberately carries no guard saying so. The empty
  // chunk returned above, every group holds at least one row, and the in-loop
  // call is gated on `current.length > 0` -- so an "if empty, return" here would
  // be a branch no test could reach, which is how a file starts collecting
  // coverage pragmas instead of reasons.
  const flush = () => {
    const message: SyncBatchMessage = {
      lane,
      captured_at: capturedAt,
      ...(passTotal !== undefined ? { pass_total: passTotal } : {}),
      ...(prunes ? { key_complete: true as const } : {}),
      rows: current,
    };
    // THE ASSERTION THIS BUG COST US. Nothing measured the message before
    // sending it, so an oversize payload surfaced as a 502 the producer read as
    // a transient network fault and retried into -- a stopped lane wearing the
    // costume of a flaky one. Measured here, at the boundary, where the failure
    // names itself.
    const bytes = JSON.stringify(message).length;
    if (bytes > QUEUE_MESSAGE_MAX_BYTES) {
      throw new Error(
        `sync-batches: ${lane} message of ${current.length} row(s) is ` +
          `${bytes} bytes, over the ${QUEUE_MESSAGE_MAX_BYTES}-byte transport ` +
          `cap; lower SYNC_BATCH_MAX_BYTES`,
      );
    }
    messages.push(message);
    current = [];
    currentBytes = 0;
  };

  for (const group of groups) {
    const groupBytes = group.reduce((n, row) => n + rowBytes(row), 0);
    if (groupBytes > maxBytes) {
      throw new Error(
        `sync-batches: ${lane} ${keyColumn ?? "row"} group of ` +
          `${group.length} row(s) is ${groupBytes} bytes, over the ` +
          `${maxBytes}-byte message budget; it cannot be split without ` +
          `breaking key_complete`,
      );
    }
    if (
      current.length > 0 &&
      (currentBytes + groupBytes > maxBytes ||
        current.length + group.length > maxRows)
    ) {
      flush();
    }
    current.push(...group);
    currentBytes += groupBytes;
  }
  flush();

  return messages;
}

/** The structural slice of a Queue binding the enqueue path uses, so a test can
 * hand it a plain object rather than stand up a binding. */
export interface SyncBatchQueue {
  /** Returns `unknown` rather than `void` so the real `Queue<T>` binding, whose
   * `send` resolves a `QueueSendResponse`, satisfies this structurally. */
  send(body: SyncBatchMessage): Promise<unknown>;
}

/**
 * Pack one posted chunk and enqueue every message it becomes.
 *
 * SENT IN PARALLEL, and order does not matter: the tally is commutative, the
 * writes are upserts, and each message of a pruning lane is independently
 * key-complete. Nothing downstream can tell which arrived first.
 *
 * A PARTIAL FAILURE OVER-DELIVERS RATHER THAN UNDER-DELIVERS. If some sends
 * succeed and one throws, the route returns 502 and the producer retries the
 * whole chunk, so the rows that did land are written twice. That is the
 * at-least-once overshoot metagraphed-infra#352 already accepted and documented:
 * `received_rows` can exceed `pass_total`, `completed_at` is stamped once and
 * never cleared, and the gate asks "did everything arrive", not "how many
 * times". The opposite trade -- acking a partial chunk -- would mark a pass
 * complete that never was.
 */
export async function enqueueSyncBatch(
  queue: SyncBatchQueue,
  input: {
    lane: SyncBatchLane;
    capturedAt: number;
    passTotal?: number;
    rows: Record<string, unknown>[];
  },
): Promise<number> {
  const messages = packSyncBatchMessages(input);
  await Promise.all(messages.map((message) => queue.send(message)));
  return messages.length;
}

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
