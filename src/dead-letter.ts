// The dead-letter queues, finally read (metagraphed-infra#354/#363).
//
// Both queues declared a `dead_letter_queue` and nothing consumed either one.
// A message that exhausts its retries lands there, sits for the queue's
// retention, and disappears — so the one class of failure the migration to
// queues was supposed to make VISIBLE was the one class nothing could see.
// #363 put it plainly: a dead-letter nobody looks at is a second log.
//
// WHAT A READER CAN AND CANNOT DO HERE. It cannot fix anything. A message
// reaches a DLQ having already failed its full budget — five attempts for
// `sync-batches`, eight for `webhook-deliveries` — so re-attempting it here
// would be a ninth attempt wearing a different hat. What it CAN do is turn a
// silent loss into a durable, alarmed record, which is the same trade
// src/lane-health.ts makes and for the same reason: a notification answers
// "was anyone paged", a row answers "was anything lost overnight".
//
// IT DOES NOT RECOVER, AND THE ALARM SHOULD NOT EITHER. Every other lane in
// `lane_health` goes stale and then goes `ok` again when its producer catches
// up, and src/lane-alarm.ts closes the issue on that recovery. A dead letter
// has no equivalent: the message is gone, and nothing later un-loses it. So
// this writes `stale` and never writes `ok`, an alarm opens after the usual
// one-hour floor, and it closes when a HUMAN has dealt with it. An alarm that
// cleared itself here would be asserting a recovery that cannot happen.
//
// The lane does age out on its own: lane-alarm stops re-raising a lane whose
// newest verdict is older than seven days, treating it as residue rather than
// an outage. So a one-off dead letter produces one issue, not a permanent one.

import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";

/** The two dead-letter queues, and the lane each reports under.
 *
 * Named for the QUEUE rather than for the producer, because that is what
 * `batch.queue` carries and a mapping keyed on anything else would need a
 * second place to stay correct. */
export const DEAD_LETTER_LANES: Readonly<Record<string, string>> = {
  "sync-batches-dlq": "sync-batches-dlq",
  "webhook-deliveries-dlq": "webhook-deliveries-dlq",
  // ONE DLQ FOR ALL FOUR PROBE LANES (#10894). It replaced
  // `attribution-sweeps-dlq`, `origin-reachability-dlq`, `revenue-probes-dlq`
  // and `compute-declarations-dlq`.
  //
  // THE FOURTH WAS NEVER IN THIS MAP, which is the defect the collapse also
  // fixes. `compute-declarations-dlq` was declared as a consumer in
  // wrangler.jsonc and omitted here, so `isDeadLetterQueue` returned false for
  // it, every branch below missed it, and its dead letters fell through to the
  // WEBHOOK handler -- deliveries POSTed at subscribers from a queue that has
  // nothing to do with them. A per-queue list that must be extended by hand
  // every time a lane is added is a list that eventually is not, which is the
  // argument for one queue rather than a better list.
  //
  // #10709/#10715 established why these lanes need a dead letter at all: a
  // target that keeps failing used to produce an `unreachable` row forever with
  // nothing saying the LANE was struggling. It now exhausts its retries and
  // lands here as a verdict.
  "probe-jobs-dlq": "probe-jobs-dlq",
};

/**
 * The LANE names a dead-letter queue reports under, as a set.
 *
 * Derived from the mapping above rather than re-listed, so a queue added there
 * is recognised here without a second edit. `laneAlarmSummary` reads this to
 * tell a DLQ lane from a producer: their durations mean different things, and
 * labelling one with the other's cadence is how a lost message got triaged as
 * a missed cycle (#10809's lesson, in the other direction).
 */
export const DEAD_LETTER_LANE_NAMES: ReadonlySet<string> = new Set(
  Object.values(DEAD_LETTER_LANES),
);

/** Whether a delivered batch came from a dead-letter queue.
 *
 * THE FIRST THING EITHER HANDLER MUST ASK. Both Workers bind their DLQ to the
 * same `queue()` export as the live queue, so without this check a dead letter
 * would be handed to the normal path and RE-PROCESSED — writing rows that
 * already failed, or re-POSTing a delivery a subscriber has already refused
 * eight times. The branch is not a nicety; it is what makes binding the DLQ to
 * the same handler safe at all. */
export function isDeadLetterQueue(name: unknown): boolean {
  return typeof name === "string" && name in DEAD_LETTER_LANES;
}

/**
 * The field naming a message's SUBJECT, per queue family — first match wins.
 *
 * ONE LIST, CHECKED IN ORDER, because a summariser with a per-queue branch is
 * a summariser that silently stops naming the next queue somebody adds. That
 * is exactly what happened: this read `lane ?? subscription_id`, which covers
 * `sync-batches` and `webhook-deliveries` and nothing else, and #10715/#10739
 * then added three more queues whose bodies carry none of them. All three
 * reported `(unidentified)` — a dead-letter verdict that says something was
 * lost and cannot say what, which is most of the value of having one.
 *
 * Measured 2026-08-11: `2 dead-lettered message(s) on revenue-probes-dlq
 * (unidentified)`, with the two `surface_id`s sitting unread in the bodies.
 *
 * The keys, and the queue each belongs to:
 *
 *   lane            sync-batches          the producer lane
 *   subscription_id webhook-deliveries    the subscriber
 *   surface_id      revenue-probes        the surface being probed
 *   origin          origin-reachability   the origin being checked
 *   netuid          attribution-sweeps    the subnet being swept
 *
 * A new queue whose body carries none of these still reports `unidentified`,
 * which is the honest answer — but the fix is one entry here rather than a
 * branch, and tests/dead-letter.test.ts asserts every live queue is covered so
 * the next omission fails rather than degrading quietly.
 */
export const DEAD_LETTER_SUBJECT_KEYS = [
  "lane",
  "subscription_id",
  "surface_id",
  "origin",
  "netuid",
] as const;

/**
 * How many distinct subjects the summary will name before counting the rest.
 *
 * A DLQ batch is up to 100 messages and this string lands in a log line and a
 * `lane_health.detail` column. Naming a hundred netuids there is the dump this
 * function exists to avoid; naming a dozen is the shape a reader needs, and
 * "+N more" keeps the total honest.
 */
export const DEAD_LETTER_MAX_NAMED_SUBJECTS = 12;

/** The subject a body names, or null when it names none of them. */
function subjectOf(body: Record<string, unknown>): string | null {
  for (const key of DEAD_LETTER_SUBJECT_KEYS) {
    const value = body[key];
    // Numbers count -- `netuid` is one, and rejecting it would have left the
    // sweep queue unidentified for the same reason the string-only check left
    // all three. NaN and Infinity do not: neither names a subject.
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${key}=${value}`;
    }
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * One line describing what landed, for the log and the lane verdict.
 *
 * SUMMARISED, NOT DUMPED. A dead-lettered `sync-batches` message can carry
 * 5,000 rows and a `webhook-deliveries` one carries a whole event body; neither
 * belongs in a log line or a `lane_health.detail` column. What is worth keeping
 * is the shape — how many, and which subjects — because that is what tells a
 * reader whether one producer broke or the database did.
 *
 * Pure, so the summary is testable without a queue.
 */
export function summarizeDeadLetterBatch(
  queueName: string,
  messages: readonly { readonly body: unknown }[],
): string {
  const keys = new Set<string>();
  for (const message of messages) {
    const body = message?.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      keys.add("unparseable");
      continue;
    }
    keys.add(subjectOf(body) ?? "unidentified");
  }
  const sorted = [...keys].sort();
  const shown = sorted.slice(0, DEAD_LETTER_MAX_NAMED_SUBJECTS);
  const named =
    sorted.length > shown.length
      ? `${shown.join(",")},+${sorted.length - shown.length} more`
      : shown.join(",");
  return `${messages.length} dead-lettered message(s) on ${queueName} (${named})`;
}

/**
 * Ack a dead-letter batch and leave a record somebody will be shown.
 *
 * ACKS UNCONDITIONALLY, including when the record cannot be written. The
 * message is already lost; refusing to ack would only cycle it through this
 * handler's own retry budget and then through a second-order dead-letter that
 * does not exist. Reporting must never be able to make the loss worse.
 */
export async function handleDeadLetterBatch(
  batch: {
    readonly queue: string;
    readonly messages: readonly {
      readonly body: unknown;
      ack: () => void;
    }[];
  },
  db: LaneHealthDb | undefined,
  nowMs: number = Date.now(),
): Promise<string> {
  const detail = summarizeDeadLetterBatch(batch.queue, batch.messages);
  console.error(`dead-letter: ${detail}`);
  for (const message of batch.messages) message.ack();
  const lane = DEAD_LETTER_LANES[batch.queue];
  if (lane && db) {
    // NOT WRAPPED IN A CATCH, and the acks above are why it does not need one:
    // recordLaneVerdict swallows every D1 error and returns false rather than
    // rejecting, and the messages are already acked by the time it runs. A
    // `.catch` here would be a branch no test can reach, which is how a file
    // starts collecting coverage pragmas instead of reasons.
    await recordLaneVerdict(db, {
      lane,
      verdict: "stale",
      // Not an age: nothing here is behind, something here is gone. A number
      // would be read as lag by every consumer of this table.
      age_ms: null,
      detail,
      checked_at: nowMs,
    });
  }
  return detail;
}
