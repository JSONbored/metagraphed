// Webhook delivery on a queue (metagraphed-infra#354).
//
// The thing worth testing here is not that a queue delivers -- Cloudflare's
// does. It is that the PROMISES the hand-rolled system made survive the move:
// eight attempts before dead-lettering, a doubling backoff clamped at 12 hours,
// a non-retryable failure dying immediately instead of burning the budget, and
// a retry that is byte-identical to its first attempt so the signature still
// verifies.
//
// Those were subscriber-visible guarantees, not implementation details. A queue
// that quietly delivered five times instead of eight would be a breaking change
// nobody announced.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyWebhookBatch,
  groupWebhookBatchBySubscription,
  WEBHOOK_DELIVERY_CONCURRENCY,
  WEBHOOK_DELIVERY_HTTP_ATTEMPTS,
  planWebhookFanOut,
  shouldDispatchChangeEvent,
  validWebhookDeliveryMessage,
  webhookDeliveryDisposition,
  webhookRetryDelaySeconds,
  WEBHOOK_QUEUE_BASE_DELAY_SECONDS,
  WEBHOOK_QUEUE_MAX_ATTEMPTS,
  WEBHOOK_QUEUE_MAX_DELAY_SECONDS,
  WEBHOOK_QUEUE_MESSAGE_MAX_BYTES,
} from "../src/webhook-queue.ts";
import {
  WEBHOOK_MAX_DELIVERY_ROUNDS,
  WEBHOOK_REDELIVERY_BASE_MS,
  WEBHOOK_REDELIVERY_MAX_MS,
} from "../src/webhooks.ts";

describe("the schedule subscribers were promised", () => {
  test("the attempt budget is the one the hand-rolled system published", () => {
    // Subscribers were told eight rounds. The transport changing is not a
    // reason to change what they were told, so this is pinned to the old
    // constant rather than to a number that happens to match today.
    assert.equal(WEBHOOK_QUEUE_MAX_ATTEMPTS, WEBHOOK_MAX_DELIVERY_ROUNDS);
  });

  test("the backoff is the same curve, in the units a queue takes", () => {
    assert.equal(
      WEBHOOK_QUEUE_BASE_DELAY_SECONDS * 1000,
      WEBHOOK_REDELIVERY_BASE_MS,
    );
    assert.equal(
      WEBHOOK_QUEUE_MAX_DELAY_SECONDS * 1000,
      WEBHOOK_REDELIVERY_MAX_MS,
    );
  });

  test("doubles per attempt and clamps at the ceiling", () => {
    assert.equal(webhookRetryDelaySeconds(1), 300, "5 min");
    assert.equal(webhookRetryDelaySeconds(2), 600);
    assert.equal(webhookRetryDelaySeconds(3), 1_200);
    assert.equal(webhookRetryDelaySeconds(8), 300 * 2 ** 7);
    // 12h is both the old window and Cloudflare's own delaySeconds ceiling, so
    // the curve never asks the platform for something it will refuse.
    assert.equal(webhookRetryDelaySeconds(99), WEBHOOK_QUEUE_MAX_DELAY_SECONDS);
  });

  test("a nonsense attempt count still yields a usable delay", () => {
    // `attempts` comes from the platform, so this is defensive rather than
    // expected -- but a NaN here would become a NaN delaySeconds and the retry
    // would be rejected, silently turning a retryable failure into a lost one.
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const delay = webhookRetryDelaySeconds(bad);
      assert.equal(Number.isFinite(delay), true, `${bad} produced ${delay}`);
      assert.equal(delay >= WEBHOOK_QUEUE_BASE_DELAY_SECONDS, true);
      assert.equal(delay <= WEBHOOK_QUEUE_MAX_DELAY_SECONDS, true);
    }
  });
});

describe("webhookDeliveryDisposition", () => {
  test("a delivered event is done", () => {
    assert.equal(
      webhookDeliveryDisposition({ status: "delivered" }, 1),
      "delivered",
    );
  });

  test("a retryable failure retries until the budget runs out", () => {
    const failed = { status: "failed", retryable: true };
    assert.equal(webhookDeliveryDisposition(failed, 1), "retry");
    assert.equal(
      webhookDeliveryDisposition(failed, WEBHOOK_QUEUE_MAX_ATTEMPTS - 1),
      "retry",
    );
    assert.equal(
      webhookDeliveryDisposition(failed, WEBHOOK_QUEUE_MAX_ATTEMPTS),
      "dead",
      "the eighth attempt is the last one",
    );
  });

  test("a NON-retryable failure dies at once, not eight attempts later", () => {
    // A 400 from the subscriber, or an SSRF-rejected URL, will not become a 200.
    // Spending the budget on it is 12 hours of pointless outbound traffic to
    // someone who already said no.
    assert.equal(
      webhookDeliveryDisposition({ status: "failed", retryable: false }, 1),
      "dead",
    );
  });

  test("a skipped subscription is terminal", () => {
    // "skipped" means the subscription itself is unusable -- no number of
    // retries makes an invalid URL valid.
    assert.equal(webhookDeliveryDisposition({ status: "skipped" }, 1), "dead");
  });

  test("a result with no verdict is treated as terminal, not retried forever", () => {
    assert.equal(webhookDeliveryDisposition(null, 1), "dead");
    assert.equal(webhookDeliveryDisposition({}, 1), "dead");
  });
});

describe("validWebhookDeliveryMessage", () => {
  const OK = { subscription_id: "sub_1", event_id: "evt_1", body: "{}" };

  test("accepts a well-formed delivery", () => {
    assert.equal(validWebhookDeliveryMessage(OK), true);
  });

  test("rejects anything it could not deliver from", () => {
    for (const bad of [
      null,
      "nope",
      { ...OK, subscription_id: "" },
      { ...OK, subscription_id: 7 },
      { ...OK, event_id: "" },
      { ...OK, body: "" },
      { ...OK, body: {} },
    ]) {
      assert.equal(
        validWebhookDeliveryMessage(bad),
        false,
        JSON.stringify(bad),
      );
    }
  });

  test("classifies a batch without throwing on the bad ones", () => {
    const { valid, invalid } = classifyWebhookBatch([
      { body: OK },
      { body: null },
      { body: { ...OK, body: "" } },
    ]);
    assert.equal(valid.length, 1);
    assert.equal(invalid, 2);
  });
});

describe("planWebhookFanOut", () => {
  const subs = [
    { id: "sub_a", filters: null },
    { id: "sub_b", filters: null },
  ];

  test("one message per matching subscriber, carrying one shared body", () => {
    const body = JSON.stringify({ kind: "subnets" });
    const { messages } = planWebhookFanOut({
      subscriptions: subs,
      eventId: "evt_1",
      bodyText: body,
      matches: () => true,
    });
    assert.deepEqual(
      messages.map((m) => m.subscription_id),
      ["sub_a", "sub_b"],
    );
    // BYTE-IDENTICAL, and the same string object's content for both: the
    // signature is over these exact bytes, so a retry that re-serialised the
    // event could produce different key order and read as a forgery.
    for (const m of messages) assert.equal(m.body, body);
  });

  test("a filtered-out subscriber is skipped, not enqueued", () => {
    const { messages, skipped } = planWebhookFanOut({
      subscriptions: subs,
      eventId: "evt_1",
      bodyText: "{}",
      matches: (s) => s.id === "sub_a",
    });
    assert.equal(messages.length, 1);
    assert.equal(skipped, 1);
  });

  test("a subscription with no id is skipped rather than enqueued unaddressed", () => {
    const { messages, skipped } = planWebhookFanOut({
      subscriptions: [{ filters: null }, { id: "", filters: null }],
      eventId: "evt_1",
      bodyText: "{}",
      matches: () => true,
    });
    assert.equal(messages.length, 0);
    assert.equal(skipped, 2);
  });

  test("an oversize delivery is reported, not enqueued to fail at send()", () => {
    // metagraphed-infra#360 is the reason this is measured at all: nothing
    // measured a sync message either, and `send()` throwing looked exactly like
    // the queue being down.
    const { messages, oversize } = planWebhookFanOut({
      subscriptions: [{ id: "sub_a", filters: null }],
      eventId: "evt_1",
      bodyText: "x".repeat(WEBHOOK_QUEUE_MESSAGE_MAX_BYTES),
      matches: () => true,
    });
    assert.equal(messages.length, 0);
    assert.equal(oversize, 1);
  });

  test("a realistic event fits comfortably, or the guard above is the wrong shape", () => {
    // The guard must not be the thing that stops normal delivery. A change
    // event is a summary, not a payload dump.
    const event = {
      type: "metagraph.publish",
      published_at: "2026-08-06T09:00:00.000Z",
      changes: { subnets: Array.from({ length: 129 }, (_, i) => i) },
    };
    const { messages, oversize } = planWebhookFanOut({
      subscriptions: [{ id: "sub_a", filters: null }],
      eventId: "evt_1",
      bodyText: JSON.stringify(event),
      matches: () => true,
    });
    assert.equal(oversize, 0);
    assert.equal(messages.length, 1);
  });

  test("no subscriptions is not an error", () => {
    for (const empty of [null, undefined, []]) {
      const { messages } = planWebhookFanOut({
        subscriptions: empty,
        eventId: "evt_1",
        bodyText: "{}",
        matches: () => true,
      });
      assert.equal(messages.length, 0);
    }
  });
});

describe("shouldDispatchChangeEvent", () => {
  const withChanges = { changes: { subnets: [7] } };

  test("dispatches a change the last tick did not", () => {
    assert.equal(
      shouldDispatchChangeEvent(withChanges, "evt_2", "evt_1"),
      true,
    );
    assert.equal(shouldDispatchChangeEvent(withChanges, "evt_1", null), true);
  });

  test("skips a snapshot that has not moved", () => {
    // The event id is content-addressed, so this is exact rather than
    // heuristic -- which is what lets the trigger be a frequent cron instead of
    // something the publish has to tell about itself.
    assert.equal(
      shouldDispatchChangeEvent(withChanges, "evt_1", "evt_1"),
      false,
    );
  });

  test("never fires an event where nothing actually changed", () => {
    // buildChangeEvent returns a well-formed event even when nothing moved.
    // Firing that every tick would be a notification that means nothing, and
    // subscribers would learn to ignore the feed.
    for (const empty of [
      { changes: {} },
      { changes: { subnets: [], artifacts: [] } },
      {},
      null,
    ]) {
      assert.equal(
        shouldDispatchChangeEvent(empty, "evt_new", "evt_old"),
        false,
        JSON.stringify(empty),
      );
    }
  });

  test("an absent event id is never dispatched", () => {
    assert.equal(shouldDispatchChangeEvent(withChanges, "", null), false);
  });
});

describe("groupWebhookBatchBySubscription (metagraphed-infra#354 fairness)", () => {
  const m = (subscription_id: unknown, event_id = "e") => ({
    body: { subscription_id, event_id, body: "{}" },
  });

  test("one subscriber's messages share ONE group, so it gets one slot", () => {
    // The whole point. The consumer runs groups in parallel and each group
    // serially, so a subscriber with four messages in a batch occupies one
    // delivery slot rather than four -- which is the starvation the deleted
    // per-subscription cap existed to prevent.
    const groups = groupWebhookBatchBySubscription([
      m("sub_a"),
      m("sub_b"),
      m("sub_a"),
      m("sub_a"),
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((g) => g.length),
      [3, 1],
    );
  });

  test("preserves order within a subscriber and across the batch", () => {
    // Per-subscriber order matters because a group runs serially -- deliveries
    // to one endpoint keep the order they were enqueued in, which parallelising
    // the flat list would have quietly given up.
    const groups = groupWebhookBatchBySubscription([
      m("sub_a", "e1"),
      m("sub_b", "e2"),
      m("sub_a", "e3"),
    ]);
    assert.deepEqual(
      groups.map((g) => g.map((x) => x.body.event_id)),
      [["e1", "e3"], ["e2"]],
    );
  });

  test("a message with no readable subscription id gets its own group", () => {
    // It is acked without delivering anything, so grouping it with a real
    // subscriber would only make that subscriber wait behind a no-op.
    const groups = groupWebhookBatchBySubscription([
      m(undefined),
      m("sub_a"),
      m(""),
      m(7),
      { body: null },
    ]);
    assert.equal(groups.length, 5);
    assert.equal(
      groups.every((g) => g.length === 1),
      true,
    );
  });

  test("an empty batch is not an error", () => {
    assert.deepEqual(groupWebhookBatchBySubscription([]), []);
  });

  test("the concurrency bound is the platform's, not a guess", () => {
    // Six is Cloudflare's documented ceiling on connections SIMULTANEOUSLY
    // WAITING FOR RESPONSE HEADERS per invocation, and a hanging subscriber is
    // exactly that for its whole timeout. A seventh is queued rather than
    // rejected, so a larger number would not error -- it would just stop being
    // the bound it claims to be.
    assert.equal(WEBHOOK_DELIVERY_CONCURRENCY, 6);
    // And one HTTP attempt per queue attempt, so the eight rounds subscribers
    // were promised are eight POSTs and not twenty-four.
    assert.equal(WEBHOOK_DELIVERY_HTTP_ATTEMPTS, 1);
  });
});
