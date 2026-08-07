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
  /**
   * The chunk's rows, for a lane that carries one array.
   *
   * OPTIONAL, because a multi-family message carries `families` INSTEAD and
   * `packMultiFamilyMessage` deletes this key outright. It was declared
   * required when every lane had rows, and stayed required after `families`
   * arrived -- so `message.rows.length` typechecked on a message that has no
   * `rows` at all, which is exactly the read that crashed the consumer's batch
   * log. The two shapes are mutually exclusive (`validSyncBatchMessage`
   * enforces it), so the honest type is "one or the other" and every read goes
   * through `syncBatchRows` / `syncBatchRowCount`.
   */
  rows?: Record<string, unknown>[];
  /**
   * Several row families that must land in ONE write (metagraphed-infra#359).
   *
   * `chain-detail` posts blocks, extrinsics, chain events and account events
   * together because a block and its extrinsics landing separately is a
   * readable-but-wrong state -- the drill-down shows a block with no calls. One
   * `rows` array cannot express that, and splitting the lane into four messages
   * would let the four retry independently, which is exactly the property the
   * single POST exists to prevent.
   *
   * OPTIONAL, AND MUTUALLY EXCLUSIVE WITH `rows`. Every existing lane carries
   * one array and is untouched by this; only a lane that declares `families`
   * uses it, so widening the wire format costs the other lanes nothing.
   */
  families?: Record<string, Record<string, unknown>[]>;
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
  /**
   * The prune key HOISTED off every row, for a message holding exactly one key.
   *
   * WHY THIS EXISTS (metagraphed-infra#355). `nominator-positions`' largest
   * coldkey holds 722 positions. A real row measures 200 bytes, so that group is
   * **141 KB** -- over the 128 KB transport cap -- and it cannot be split,
   * because splitting a coldkey deletes rows the message never carried.
   *
   * The coldkey is IDENTICAL on all 722 rows by construction: it is what groups
   * them. Carrying it once instead of 722 times removes ~62 bytes a row and
   * brings the message to ~97 KB. The consumer re-injects it before writing, so
   * the WRITER is untouched -- this is a wire encoding, not a schema change.
   *
   * Present only when a message holds a single key AND needed the room. Every
   * other message carries whole rows, so the common path is unchanged.
   */
  key_column?: string;
  key_value?: string;
}

/**
 * A message that definitely carries rows, which is what the packer emits.
 *
 * `rows` is optional on the wire type because the multi-family shape omits it,
 * but `packSyncBatchMessages` builds every message from a row array and can
 * never produce one without. Narrowing here keeps that guarantee in the type
 * system rather than in the reader's memory.
 */
export type SyncBatchRowsMessage = SyncBatchMessage & {
  rows: Record<string, unknown>[];
};

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
 * A lane belongs here only once its POSTs are known to carry whole keys --
 * listing one earlier makes every message assert something false, on the one
 * field whose failure mode is deleted rows. `PRUNING_LANE_KEYS` says WHICH key;
 * this says which lanes have earned the claim.
 */
export const PRUNING_LANES: readonly string[] = [
  "nominator-positions",
  // metagraphed-infra#357. It prunes per netuid, and it can assert
  // key-completeness for a reason worth stating: its producer NEVER chunks.
  // `metagraph.rs` bails -- "refusing to truncate a partial snapshot" -- if a
  // pass exceeds its 50,000-row ceiling, and a pass is ~33,000 rows, so the
  // whole snapshot arrives in one POST or none of it does. The packer then
  // groups that POST by netuid, so every message really does carry every row
  // for each netuid it names.
  "neurons",
];

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

/** Room left for the message envelope when deciding whether a LONE group needs
 * its key hoisted -- the lane name, timestamps, flags, brackets and the
 * platform's own ~100 bytes. Small, because at this point the question is only
 * "does this one group fit at all". */
const ENVELOPE_HEADROOM = 2 * 1024;

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
/**
 * Lanes whose write covers SEVERAL row families that must land together
 * (metagraphed-infra#359).
 *
 * An allowlist rather than "any lane may send families", for the same reason
 * SYNC_BATCH_LANES is one: the consumer has to know how to write what arrives,
 * and a family name it does not recognise is a table it would have to guess at.
 */
export const MULTI_FAMILY_LANES: readonly string[] = ["chain-detail"];

/**
 * Lanes refused this transport **as it is currently encoded**.
 *
 * MEASURED, not assumed (metagraphed-infra#359). `chain-detail`'s indivisible
 * unit is one block: its four families are posted together precisely so a block
 * and its extrinsics cannot land separately, and `packMultiFamilyMessage`
 * refuses to split them for that reason. So the question is never "how many
 * blocks per message" — it is whether ONE block fits.
 *
 * As raw JSON it does not. Built from the real rows of the busiest block
 * captured (#8790494 — 35 extrinsics, 694 chain events, 515 account events,
 * 1,245 rows):
 *
 *   raw JSON     476.6 KiB      against a 128 KiB per-message cap — 3.7x over
 *
 * No producer setting reaches that, because the batch is already one block.
 *
 * THE FIX IS COMPRESSION, AND IT IS NOT CLOSE. The payload is enormously
 * repetitive — the same ss58 addresses, pallet names and event kinds over and
 * over — and gzip gets **11.8x** on exactly these bytes:
 *
 *   gzip -9       40.5 KiB      87.5 KiB of headroom, ~3 blocks per message
 *
 * That is a real design change (`CompressionStream` at the route,
 * `DecompressionStream` at the consumer, a measured ceiling, and a loud failure
 * when a pathological block still overflows), which is why it is its own issue
 * rather than something smuggled in here.
 *
 * WHY THIS IS A GUARD AND NOT A COMMENT, in the meantime. Adding a lane to
 * SYNC_QUEUE_LANES is deliberately a one-word deploy-time change. Without this,
 * that one word turns every chain-detail tick into a 502 from an oversize
 * `send()` — and the producer advances its cursor only on a POST that
 * succeeded, so the lane does not degrade, it WEDGES, retrying the same
 * oversized batch forever. The cheapest possible mistake would take out the
 * highest-cadence lane, and chain-detail is also the largest D1 writer here:
 * ~1,245 rows every 12 seconds is ~9M rows/day, against account-balances'
 * ~1.5M. It is the lane the queue most wants, which is exactly why the
 * placeholder must fail closed.
 *
 * Everything else stays: the message shape, the packer and the consumer's
 * family writer are correct and tested, and compression drops in behind them
 * without touching any of it.
 */
export const QUEUE_INELIGIBLE_LANES: Readonly<Record<string, string>> = {
  "chain-detail":
    "one block is 476.6 KiB of raw JSON (measured on #8790494) against a " +
    "128 KiB per-message cap, and its four families cannot be split without " +
    "losing the atomicity they travel together for. gzip takes the same bytes " +
    "to 40.5 KiB, so this is a compression change rather than a permanent " +
    "exclusion -- see metagraphed-infra#383",
};

/** The family names each multi-family lane may send. A name outside this list
 * is refused rather than written to a guessed table. */
export const MULTI_FAMILY_LANE_ROW_FAMILIES: Readonly<
  Record<string, readonly string[]>
> = {
  "chain-detail": [
    "blockRows",
    "extrinsicRows",
    "chainEventRows",
    "accountEventRows",
  ],
};

export const PRUNING_LANE_KEYS: Readonly<Record<string, string>> = {
  "nominator-positions": "coldkey",
  neurons: "netuid",
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
   * NOT one list -- a lane can have a known prune key while its producer cannot
   * yet guarantee whole keys per POST, and listing it before then would make
   * every message assert something false -- so the mismatch is possible and the
   * guard is not decorative. */
  pruningKeys?: Readonly<Record<string, string>>;
}): SyncBatchRowsMessage[] {
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

  const messages: SyncBatchRowsMessage[] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 0;

  // NEVER CALLED EMPTY, and deliberately carries no guard saying so. The empty
  // chunk returned above, every group holds at least one row, and the in-loop
  // call is gated on `current.length > 0` -- so an "if empty, return" here would
  // be a branch no test could reach, which is how a file starts collecting
  // coverage pragmas instead of reasons.
  let hoistKey: string | null = null;
  const flush = () => {
    const hoisted = hoistKey;
    const keyValue = hoisted ? String(current[0]![hoisted]) : undefined;
    const rows = hoisted
      ? current.map((row) => {
          const { [hoisted]: _key, ...rest } = row;
          return rest;
        })
      : current;
    const message: SyncBatchRowsMessage = {
      lane,
      captured_at: capturedAt,
      ...(passTotal !== undefined ? { pass_total: passTotal } : {}),
      ...(prunes ? { key_complete: true as const } : {}),
      ...(hoisted ? { key_column: hoisted, key_value: keyValue } : {}),
      rows,
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
          `cap. A single ${keyColumn ?? "row"} group this large cannot be ` +
          `split without breaking key_complete, so the PRODUCER must reduce it.`,
      );
    }
    messages.push(message);
    current = [];
    currentBytes = 0;
  };

  for (const group of groups) {
    const groupBytes = group.reduce((n, row) => n + rowBytes(row), 0);
    // AN INDIVISIBLE GROUP ANSWERS TO THE TRANSPORT, NOT TO THE BUDGET.
    //
    // `maxBytes` decides when to stop COMBINING groups into one message. A
    // group that exceeds it alone cannot be combined with anything -- but it
    // can still be a message, because the only real limit on one message is the
    // 128 KB transport cap. Treating both with one number is what made a
    // legitimate coldkey unpackable: nominator-positions' largest holds 722
    // positions, ~108 KB, over the 96 KB budget and comfortably under the cap.
    // The lane 502'd on its first tick (metagraphed-infra#355) until this
    // distinction existed.
    //
    // It goes ALONE, and `flush()` checks it against the real cap -- so a group
    // that genuinely cannot fit still fails loudly rather than being split.
    if (groupBytes > maxBytes) {
      if (current.length > 0) flush();
      current = [...group];
      currentBytes = groupBytes;
      // HOIST THE KEY when the group alone would still not fit. It is identical
      // on every row of the group by construction, so carrying it once instead
      // of N times is free room -- ~62 bytes a row for a coldkey, which is what
      // brings a 722-position group from 141 KB under the 128 KB cap. The
      // consumer re-injects before writing, so the writer never sees the
      // difference.
      if (
        keyColumn &&
        groupBytes > QUEUE_MESSAGE_MAX_BYTES - ENVELOPE_HEADROOM
      ) {
        hoistKey = keyColumn;
      }
      flush();
      hoistKey = null;
      continue;
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
  if (current.length > 0) flush();

  return messages;
}

/**
 * Pack one multi-family chunk (metagraphed-infra#359).
 *
 * ALL FAMILIES IN ONE MESSAGE OR NONE. Splitting them by byte budget the way
 * `packSyncBatchMessages` splits rows would defeat the point: a block and its
 * extrinsics arriving in two messages can retry independently, and the
 * intermediate state -- a block whose drill-down shows no calls -- is readable
 * and wrong. So an oversize chunk THROWS rather than degrading into the split
 * this shape exists to prevent.
 *
 * That is a real constraint, not a hypothetical: the producer batches 2 blocks
 * per POST at ~350-662 KiB, which is over the 128 KB cap. The producer has to
 * post smaller batches for this lane to move -- and a loud error at the
 * boundary is how that gets discovered, rather than a silently split write.
 */
export function packMultiFamilyMessage(input: {
  lane: SyncBatchLane;
  capturedAt: number;
  passTotal?: number;
  families: Record<string, Record<string, unknown>[]>;
  maxBytes?: number;
}): SyncBatchMessage {
  const {
    lane,
    capturedAt,
    passTotal,
    families,
    maxBytes = SYNC_BATCH_MAX_BYTES,
  } = input;
  const message: SyncBatchMessage = {
    lane,
    captured_at: capturedAt,
    ...(passTotal !== undefined ? { pass_total: passTotal } : {}),
    families,
  } as SyncBatchMessage;
  // `rows` is absent by construction here; the validator refuses a message
  // carrying both, so the type's required `rows` is deliberately not set.
  delete (message as { rows?: unknown }).rows;

  const bytes = JSON.stringify(message).length;
  if (bytes > maxBytes) {
    const counts = Object.entries(families)
      .map(([name, rows]) => `${name}=${rows.length}`)
      .join(", ");
    throw new Error(
      `sync-batches: ${lane} multi-family message is ${bytes} bytes (${counts}), ` +
        `over the ${maxBytes}-byte budget; these families must land together, ` +
        `so the PRODUCER must post a smaller batch rather than this splitting them`,
    );
  }
  return message;
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
  // A multi-family message carries `families` INSTEAD of `rows`. Accepting both
  // would leave the writer to guess which one is authoritative, and a lane that
  // sent both would write one of them silently.
  if (m.families !== undefined) {
    if (m.rows !== undefined) return false;
    if (!MULTI_FAMILY_LANES.includes(m.lane)) return false;
    const families = m.families as Record<string, unknown> | null;
    if (!families || typeof families !== "object" || Array.isArray(families)) {
      return false;
    }
    const names = Object.keys(families);
    if (names.length === 0) return false;
    const expected = MULTI_FAMILY_LANE_ROW_FAMILIES[m.lane];
    let total = 0;
    for (const name of names) {
      if (expected && !expected.includes(name)) return false;
      const rows = families[name];
      if (!Array.isArray(rows)) return false;
      if (!rows.every((r) => r !== null && typeof r === "object")) return false;
      total += rows.length;
    }
    // The row ceiling is on the WHOLE message, not per family: the transport
    // caps the payload, and four families of 5,000 is 20,000 rows in one
    // message however it is spelled.
    if (total === 0 || total > SYNC_BATCH_MAX_ROWS) return false;
    if (m.pass_total !== undefined && m.pass_total < total) return false;
    return true;
  }
  if (!Array.isArray(m.rows) || m.rows.length === 0) return false;
  // A pruning lane must SAY its chunk is key-complete. Refusing here beats
  // pruning on trust: the failure mode is deleted rows, which no retry undoes.
  if (PRUNING_LANES.includes(m.lane) && m.key_complete !== true) {
    return false;
  }
  if (m.rows.length > SYNC_BATCH_MAX_ROWS) return false;
  // A hoisted key needs both halves, and only makes sense for a pruning lane --
  // it is the prune key that is constant, and nothing else is.
  if (m.key_column !== undefined || m.key_value !== undefined) {
    if (typeof m.key_column !== "string" || !m.key_column) return false;
    if (typeof m.key_value !== "string" || !m.key_value) return false;
    if (!PRUNING_LANES.includes(m.lane)) return false;
    if (PRUNING_LANE_KEYS[m.lane] !== m.key_column) return false;
    // The rows must NOT also carry it, or the two could disagree and the
    // consumer would have to decide which is authoritative.
    if (m.rows.some((r) => m.key_column! in r)) return false;
  }
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
 *
 * ONE LANE OVERRIDES THE FLAG. A lane in QUEUE_INELIGIBLE_LANES does not fit
 * the transport at any producer setting, so naming it here is a mistake the
 * flag cannot express -- and an unexpressible mistake should be refused, not
 * obeyed. See that constant for the measurement.
 */
export function syncLaneUsesQueue(
  env: { SYNC_BATCHES?: unknown; SYNC_QUEUE_LANES?: string },
  lane: SyncBatchLane,
): boolean {
  if (!env.SYNC_BATCHES) return false;
  if (lane in QUEUE_INELIGIBLE_LANES) return false;
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

/** A multi-family lane's writer. Separate from SyncBatchWriter rather than a
 * union, so a lane cannot be wired to the wrong one by accident: the type says
 * which shape it consumes. */
export type SyncBatchFamilyWriter = (
  families: Record<string, Record<string, unknown>[]>,
  pass: PassTally | null,
) => Promise<unknown>;

/** Lane -> its D1 writer. PARTIAL on purpose: a lane may be accepted by the
 * validator before its writer is wired, and writeSyncBatch throws rather than
 * silently skipping so a half-migrated lane fails loudly instead of leaving a
 * pass that never completes. */
export type SyncBatchWriters = Partial<Record<SyncBatchLane, SyncBatchWriter>>;
export type SyncBatchFamilyWriters = Partial<
  Record<SyncBatchLane, SyncBatchFamilyWriter>
>;

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
    // A multi-family message delivers the SUM of its families. Counting only
    // `rows` there would credit zero and the pass would never close.
    receivedRows: syncBatchRowCount(message),
    nowMs,
  };
}

/**
 * The rows a message means, with a hoisted key re-injected.
 *
 * The writer never sees the wire encoding: it gets whole rows either way, so
 * hoisting stayed a transport optimisation rather than becoming a schema the
 * D1 layer has to know about.
 */
export function syncBatchRows(
  message: SyncBatchMessage,
): Record<string, unknown>[] {
  // A multi-family message has no `rows`, and never reaches here -- writeSyncBatch
  // hands it to the family writer and returns. Empty rather than a throw so the
  // fallback is the harmless one: a writer given nothing writes nothing.
  const rows = message.rows ?? [];
  if (!message.key_column) return rows;
  const column = message.key_column;
  const value = message.key_value;
  return rows.map((row) => ({ ...row, [column]: value }));
}

/** How many rows a message actually carries, whichever shape it uses. */
export function syncBatchRowCount(message: SyncBatchMessage): number {
  if (message.families) {
    return Object.values(message.families).reduce(
      (n, rows) => n + rows.length,
      0,
    );
  }
  return message.rows?.length ?? 0;
}

/** Dispatch one validated message to its lane's writer. Separated from the
 * Worker handler so the routing is testable without a queue. */
export async function writeSyncBatch(
  message: SyncBatchMessage,
  writers: SyncBatchWriters,
  nowMs: number = Date.now(),
  familyWriters: SyncBatchFamilyWriters = {},
): Promise<void> {
  if (message.families) {
    const familyWriter = familyWriters[message.lane as SyncBatchLane];
    if (!familyWriter) {
      throw new Error(
        `sync-batches: no family writer for lane ${message.lane}`,
      );
    }
    // ONE CALL, so the families land in one D1 batch -- which is the entire
    // reason they travel together. Writing them in a loop here would restore
    // the split the message shape exists to prevent.
    await familyWriter(message.families, passTallyFor(message, nowMs));
    return;
  }
  const writer = writers[message.lane as SyncBatchLane];
  if (!writer) {
    // Unreachable given validSyncBatchMessage's allowlist, and thrown rather
    // than ignored: a silently skipped lane is a pass that never completes.
    throw new Error(`sync-batches: no writer for lane ${message.lane}`);
  }
  // syncBatchRows, not message.rows: a hoisted key is re-injected here so the
  // writer -- and the prune map it derives -- see whole rows.
  await writer(syncBatchRows(message), passTallyFor(message, nowMs));
}
