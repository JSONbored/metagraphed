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
};

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
 * One line describing what landed, for the log and the lane verdict.
 *
 * SUMMARISED, NOT DUMPED. A dead-lettered `sync-batches` message can carry
 * 5,000 rows and a `webhook-deliveries` one carries a whole event body; neither
 * belongs in a log line or a `lane_health.detail` column. What is worth keeping
 * is the shape — how many, from which lanes or subscriptions — because that is
 * what tells a reader whether one producer broke or the database did.
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
    // `lane` for sync-batches, `subscription_id` for webhook-deliveries. One
    // reader for both queues means reading whichever identity the message has,
    // rather than two near-identical modules that drift.
    const key = body.lane ?? body.subscription_id;
    keys.add(typeof key === "string" && key ? key : "unidentified");
  }
  const named = [...keys].sort().join(",");
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
