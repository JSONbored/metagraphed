// Webhook delivery, on a queue (metagraphed-infra#354).
//
// WHAT THIS REPLACES. `src/webhooks.ts` grew a message queue by hand:
// `dispatchWithRedelivery` parks a failed delivery in KV, sweeps the parked
// backlog on the next publish run, schedules each record with its own
// exponential round counter, dead-letters after eight rounds, and budgets the
// sweep so one chronically-failing endpoint cannot monopolise it
// (`WEBHOOK_REDELIVERY_MAX_PER_RUN`, `WEBHOOK_REDELIVERY_MAX_PER_SUBSCRIPTION`).
// Parking, bounded retry, a redelivery window, dead-lettering and fairness --
// every one of them is a queue primitive, hand-written here because there was
// no queue.
//
// IT MATTERS MORE THAN THE SYNC LANES. Those deliver to our own database, where
// a retry is an implementation detail. These deliver to THIRD PARTIES, where
// retry and dead-letter semantics ARE the product: a subscriber's integration is
// built on what we promise about redelivery.
//
// WHERE THE FAIRNESS CAP WENT, since deleting a safeguard deserves an argument
// rather than a shrug. `WEBHOOK_REDELIVERY_MAX_PER_SUBSCRIPTION` existed because
// the sweep drew from ONE SHARED BACKLOG under ONE PER-RUN BUDGET: 64 redeliveries
// a run, so a subscriber with 500 parked deliveries would take every slot and
// starve everyone else. The cap was rationing a scarce shared resource.
//
// A queue has no such resource. Each delivery is its own message with its own
// retry clock, and a failed one is RESCHEDULED (`retry({ delaySeconds })`), not
// spun on -- so a failing subscriber's messages are not competing for anything
// between attempts; they are simply not due yet. The thing the cap protected
// against no longer exists, which is the only honest reason to delete a
// safeguard. What remains bounded is consumer concurrency (`max_concurrency`),
// and that is a bound on simultaneous work rather than a budget one subscriber
// can exhaust for the rest.
//
// WHAT DOES NOT MOVE. `deliverChangeEvent` -- the signed POST, the
// delivery-time URL re-validation, the SSRF guard, the idempotency key -- is the
// product, not scaffolding. It stays exactly as it is; this only changes what
// decides to call it and what happens when it fails.

/** One delivery: one event, to one subscriber. */
export interface WebhookDeliveryMessage {
  /** Which subscription to deliver to. Resolved at consume time rather than
   * embedded, so a subscription deleted between enqueue and delivery is not
   * delivered to from a stale copy. */
  subscription_id: string;
  /** The content-addressed event id, stable across retries -- it is half of the
   * idempotency key a subscriber dedupes on. */
  event_id: string;
  /** The exact bytes to POST. Carried rather than rebuilt so a retry sends
   * BYTE-IDENTICAL content to the first attempt: the signature is over this
   * body, and a subscriber verifying it against a re-serialised payload with
   * different key order would see a valid delivery as a forgery. */
  body: string;
}

/**
 * Attempts before a delivery dead-letters.
 *
 * Deliberately the same 8 as `WEBHOOK_MAX_DELIVERY_ROUNDS`, because subscribers
 * were told that number. The transport changed; the promise did not.
 */
export const WEBHOOK_QUEUE_MAX_ATTEMPTS = 8;

/** First retry delay, doubling per attempt. Matches WEBHOOK_REDELIVERY_BASE_MS. */
export const WEBHOOK_QUEUE_BASE_DELAY_SECONDS = 5 * 60;

/** The ceiling each doubling is clamped to. Matches WEBHOOK_REDELIVERY_MAX_MS.
 * Cloudflare caps `delaySeconds` at 12 hours, which is exactly this value --
 * the hand-rolled schedule and the platform's limit agree by coincidence, and
 * `webhookRetryDelaySeconds` never has to be clamped twice. */
export const WEBHOOK_QUEUE_MAX_DELAY_SECONDS = 12 * 60 * 60;

/**
 * How long before a failed delivery is tried again: `base * 2^(attempts-1)`,
 * clamped.
 *
 * `attempts` is what the platform reports for the message -- 1 on the first
 * delivery -- so the round counter that used to be persisted in the parked KV
 * record is now carried by the transport. That is the single biggest deletion
 * here: the old code had to re-read the prior record before re-parking, because
 * trusting a stale in-memory snapshot reset the round to 1 and a chronically
 * failing endpoint would then never reach the dead-letter cap.
 */
export function webhookRetryDelaySeconds(
  attempts: number,
  baseSeconds: number = WEBHOOK_QUEUE_BASE_DELAY_SECONDS,
  maxSeconds: number = WEBHOOK_QUEUE_MAX_DELAY_SECONDS,
): number {
  const round = Number.isFinite(attempts) && attempts >= 1 ? attempts : 1;
  // Exponent capped before the shift so a large attempt count cannot overflow
  // into Infinity and then clamp to max by accident rather than by rule.
  const doublings = Math.min(round - 1, 32);
  return Math.min(baseSeconds * 2 ** doublings, maxSeconds);
}

/**
 * Validate one message off the queue.
 *
 * A malformed message is ACKED, not retried -- the same disposition rule the
 * sync-batches consumer follows: retrying something that can never parse burns
 * the attempt budget and dead-letters anyway, so the DLQ keeps holding
 * deliveries that might yet succeed rather than ones that never could.
 */
export function validWebhookDeliveryMessage(
  body: unknown,
): body is WebhookDeliveryMessage {
  const m = body as WebhookDeliveryMessage | null;
  if (!m || typeof m !== "object") return false;
  if (typeof m.subscription_id !== "string" || !m.subscription_id) return false;
  if (typeof m.event_id !== "string" || !m.event_id) return false;
  if (typeof m.body !== "string" || !m.body) return false;
  return true;
}

/** Split a batch into what can be delivered and what can only be dropped. */
export function classifyWebhookBatch(
  messages: readonly { readonly body: unknown }[],
): { valid: WebhookDeliveryMessage[]; invalid: number } {
  const valid: WebhookDeliveryMessage[] = [];
  let invalid = 0;
  for (const message of messages) {
    if (validWebhookDeliveryMessage(message.body)) valid.push(message.body);
    else invalid += 1;
  }
  return { valid, invalid };
}

/**
 * The transport's per-message ceiling, as for sync-batches
 * (metagraphed-infra#360). Nothing measured a message there either, and the
 * result was a lane that stopped rather than degraded.
 */
export const WEBHOOK_QUEUE_MESSAGE_MAX_BYTES = 128 * 1024;

/**
 * What a subscriber is owed for one published event, as queue messages.
 *
 * ONE BODY, MANY MESSAGES. The event body is identical for every subscriber --
 * only the per-subscriber signature and idempotency header differ, and both are
 * computed at delivery -- so the same string is carried on each message rather
 * than re-serialised per subscriber. That is what makes a retry byte-identical
 * to its first attempt.
 *
 * A subscription whose delivery would exceed the transport's message cap is
 * SKIPPED AND REPORTED rather than enqueued to fail: an oversize message throws
 * at `send()`, and the caller cannot tell that apart from the queue being down.
 */
export function planWebhookFanOut({
  subscriptions,
  eventId,
  bodyText,
  matches,
  maxBytes = WEBHOOK_QUEUE_MESSAGE_MAX_BYTES,
}: {
  subscriptions: readonly Record<string, unknown>[] | null | undefined;
  eventId: string;
  bodyText: string;
  /** Whether this subscription's filters select the event. Injected so the
   * planner stays pure and the filter rule keeps its single implementation in
   * `src/webhooks.ts`. */
  matches: (subscription: Record<string, unknown>) => boolean;
  maxBytes?: number;
}): { messages: WebhookDeliveryMessage[]; skipped: number; oversize: number } {
  const messages: WebhookDeliveryMessage[] = [];
  let skipped = 0;
  let oversize = 0;
  for (const subscription of subscriptions ?? []) {
    const id = subscription?.id;
    if (typeof id !== "string" || !id) {
      skipped += 1;
      continue;
    }
    if (!matches(subscription)) {
      skipped += 1;
      continue;
    }
    const message: WebhookDeliveryMessage = {
      subscription_id: id,
      event_id: eventId,
      body: bodyText,
    };
    if (JSON.stringify(message).length > maxBytes) {
      oversize += 1;
      continue;
    }
    messages.push(message);
  }
  return { messages, skipped, oversize };
}

/** What the consumer decided to do with one message, so a batch's outcome is
 * reportable rather than inferred from an absence of errors. */
export type WebhookDeliveryDisposition = "delivered" | "retry" | "dead";

/**
 * Turn one delivery result into a disposition.
 *
 * THREE OUTCOMES, NOT TWO. A delivered event acks. A retryable failure retries
 * until the attempt budget runs out, then dead-letters -- and a NON-retryable
 * failure (a 400 from the subscriber, an SSRF-rejected URL, a deleted
 * subscription) dead-letters IMMEDIATELY rather than consuming eight attempts to
 * reach the same place. That distinction is the whole reason `deliverChangeEvent`
 * reports `retryable` at all, and losing it would turn every subscriber's typo
 * into 12 hours of pointless outbound traffic.
 */
export function webhookDeliveryDisposition(
  result: { status?: unknown; retryable?: unknown } | null | undefined,
  attempts: number,
  maxAttempts: number = WEBHOOK_QUEUE_MAX_ATTEMPTS,
): WebhookDeliveryDisposition {
  if (result?.status === "delivered") return "delivered";
  // "skipped" is terminal by construction -- the subscription is unusable, and
  // no number of retries makes an invalid URL valid.
  if (result?.status === "skipped") return "dead";
  if (result?.retryable !== true) return "dead";
  return attempts >= maxAttempts ? "dead" : "retry";
}

/** Where the last dispatched event id is remembered, so a cron that runs far
 * more often than a publish does not re-fan an event subscribers already got. */
export const WEBHOOK_LAST_DISPATCHED_KEY = "webhooks:last-dispatched";

/**
 * Decide whether a change event is new, given what was dispatched last.
 *
 * THE EVENT ID IS CONTENT-ADDRESSED, so this is exact rather than heuristic: an
 * unchanged snapshot hashes to the same id and is skipped, and any real change
 * produces a different one. That is what lets the trigger be a frequent cron
 * instead of something wired to the publish -- the publish no longer has to tell
 * anyone it happened.
 *
 * An EMPTY event is never dispatched. `buildChangeEvent` returns a well-formed
 * event even when nothing moved, and firing that at subscribers every tick would
 * be a notification that means nothing.
 */
export function shouldDispatchChangeEvent(
  event: { changes?: unknown } | null | undefined,
  eventId: string,
  lastDispatchedId: string | null | undefined,
): boolean {
  if (!event || !eventId) return false;
  if (eventId === lastDispatchedId) return false;
  const changes = event.changes as Record<string, unknown> | undefined;
  if (!changes || typeof changes !== "object") return false;
  // "Something actually moved" -- any non-empty array under changes.
  return Object.values(changes).some(
    (value) => Array.isArray(value) && value.length > 0,
  );
}
