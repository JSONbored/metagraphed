// The queue semantics, written once.
//
// Three lanes moved from crons to queues (#10715) and each arrived with its own
// copy of the same two functions: a producer that checks the binding, refuses an
// empty set, chunks at Cloudflare's send cap and reports partial sends; and a
// consumer that acks on success, retries on failure, and acks a body it cannot
// parse. Three copies of that is three places for the ack/retry decision to
// drift -- and that decision is the one with consequences, because getting it
// backwards either loses work silently or loops a message to the dead letter
// forever.
//
// So it lives here once, and a lane supplies only what is actually different:
// what to enqueue, how to read a body, and what to do with one subject.
//
// THE THREE OUTCOMES, and why each is what it is:
//
//   - ACK on success. The obvious one.
//   - RETRY on failure. Including a failed WRITE after successful work: an
//     unwritten result is one nothing can read, so the work did not happen as
//     far as any reader is concerned.
//   - ACK, not retry, on a body that cannot be parsed or a subject that no
//     longer exists. Neither will change on redelivery, so retrying spends the
//     whole budget to reach the dead letter with a message nobody can act on.
//     That is the one people get wrong.

/** Cloudflare's cap on a single sendBatch. */
export const SEND_BATCH_MAX = 100;

export interface LaneQueue<TBody> {
  sendBatch(messages: Array<{ body: TBody }>): Promise<unknown>;
}

export interface EnqueueResult {
  ok: boolean;
  enqueued: number;
  reason?: string;
}

/**
 * Enqueue every body, in send-cap-sized chunks.
 *
 * AN EMPTY SET IS NOT A SUCCESS, and the caller names the reason. A producer
 * reporting `ok` while enqueuing nothing is indistinguishable from one that
 * enqueued and found nothing to do -- which is how the revenue lane sat dead for
 * two months while every route it fed reported null (#10566).
 *
 * The BINDING is checked before the empty set, deliberately: a missing binding
 * is a configuration error, and reporting "nothing to enqueue" would send
 * somebody to the registry instead of to wrangler.jsonc.
 */
export async function enqueueAll<TBody>(
  queue: LaneQueue<TBody> | null | undefined,
  bodies: TBody[],
  emptyReason: string,
): Promise<EnqueueResult> {
  if (!queue?.sendBatch) {
    return { ok: false, enqueued: 0, reason: "no_queue_binding" };
  }
  if (bodies.length === 0) {
    return { ok: false, enqueued: 0, reason: emptyReason };
  }
  let enqueued = 0;
  try {
    for (let i = 0; i < bodies.length; i += SEND_BATCH_MAX) {
      const slice = bodies.slice(i, i + SEND_BATCH_MAX);
      await queue.sendBatch(slice.map((body) => ({ body })));
      enqueued += slice.length;
    }
  } catch (error) {
    // Partial sends are reported as partial. A producer that swallowed the
    // count would make "the queue rejected half of these" look like a clean
    // pass over a smaller set.
    return {
      ok: false,
      enqueued,
      reason: `send_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  return { ok: true, enqueued };
}

/** One delivered message, as a consumer sees it. */
export interface LaneMessage {
  body: unknown;
  ack(): void;
  retry(): void;
}

export interface ConsumeResult {
  /** Acked after the work succeeded. */
  done: number;
  /** Handed back for redelivery. */
  retried: number;
  /** Acked WITHOUT doing the work: unparseable, or a subject that is gone. */
  dropped: number;
}

export interface ConsumeHandlers<TSubject> {
  /** Read a delivered body. Null means it can never be acted on. */
  parse(body: unknown): TSubject | null;
  /** Do the work. Return false or throw to have the message redelivered;
   * return true when the result is durably written. */
  run(subject: TSubject): Promise<boolean>;
}

/**
 * Consume a batch, one subject per message.
 *
 * One message failing never stops the rest of the batch -- each is acked or
 * retried on its own, which is the property that makes a poison message cost one
 * subject rather than all of them.
 */
export async function consumeBatch<TSubject>(
  messages: LaneMessage[],
  handlers: ConsumeHandlers<TSubject>,
): Promise<ConsumeResult> {
  let done = 0;
  let retried = 0;
  let dropped = 0;
  for (const message of messages) {
    try {
      // `parse` is inside the try as well: a parse that throws is a programming
      // error, and letting it propagate would fail the WHOLE batch -- one bad
      // message taking out every other subject delivered beside it, which is
      // the property this loop exists to prevent.
      const subject = handlers.parse(message.body);
      if (subject === null) {
        message.ack();
        dropped += 1;
        continue;
      }
      if (await handlers.run(subject)) {
        message.ack();
        done += 1;
      } else {
        message.retry();
        retried += 1;
      }
    } catch {
      message.retry();
      retried += 1;
    }
  }
  return { done, retried, dropped };
}
