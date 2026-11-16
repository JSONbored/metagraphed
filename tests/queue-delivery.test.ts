import assert from "node:assert/strict";
import { test } from "vitest";
import {
  queueDelaySeconds,
  queueDelivery as createDelivery,
} from "../src/queue-delivery.ts";

const queueDelivery = (
  queue: string,
  payloads: Parameters<typeof createDelivery>[1],
) =>
  createDelivery(queue, payloads, {
    backlogCount: payloads.length,
    backlogBytes: 0,
  });
const payloads = () =>
  ["a", "b", "c"].map((id) => ({
    id,
    createdAtMs: 1000,
    attempts: 2,
    body: { id },
  }));
test("preserves message identity, bodies, dates and one-based attempts", () => {
  const source = payloads();
  const delivery = queueDelivery("probe-jobs", source);
  assert.equal(delivery.batch.queue, "probe-jobs");
  assert.equal(delivery.batch.messages[0]!.id, "a");
  assert.equal(delivery.batch.messages[0]!.body, source[0]!.body);
  assert.equal(delivery.batch.messages[0]!.timestamp.getTime(), 1000);
  assert.equal(delivery.batch.messages[0]!.attempts, 2);
  assert.deepEqual(
    delivery.finish(false),
    source.map(() => ({ action: "ack" })),
  );
});
test("individual first decision wins and overrides batch decisions in either order", () => {
  const delivery = queueDelivery("probe-jobs", payloads());
  delivery.batch.retryAll({ delaySeconds: 10 });
  delivery.batch.ackAll();
  delivery.batch.messages[0]!.ack();
  delivery.batch.messages[0]!.retry({ delaySeconds: -1 });
  delivery.batch.messages[1]!.retry({ delaySeconds: 0 });
  delivery.batch.messages[1]!.ack();
  assert.deepEqual(delivery.finish(true), [
    { action: "ack" },
    { action: "retry", delaySeconds: 0 },
    { action: "retry", delaySeconds: 10 },
  ]);
  delivery.batch.messages[2]!.ack();
  delivery.batch.ackAll();
  assert.deepEqual(delivery.finish(true)[2], {
    action: "retry",
    delaySeconds: 10,
  });
});
test("batch defaults acknowledge a thrown invocation while explicit retry survives", () => {
  const delivery = queueDelivery("probe-jobs", payloads());
  delivery.batch.messages[0]!.retry();
  delivery.batch.ackAll();
  delivery.batch.retryAll({ delaySeconds: -1 });
  assert.deepEqual(delivery.finish(true), [
    { action: "retry" },
    { action: "ack" },
    { action: "ack" },
  ]);
  const fallback = queueDelivery("probe-jobs", payloads());
  assert.deepEqual(
    fallback.finish(true),
    payloads().map(() => ({ action: "retry" })),
  );
});
test("missing delays preserve queue defaults; explicit zero and bounded maximum are valid", () => {
  assert.equal(queueDelaySeconds(undefined), 0);
  assert.equal(queueDelaySeconds(undefined, 600), 600);
  assert.equal(queueDelaySeconds(86400), 86400);
  for (const delay of [-1, 86401, NaN, 0.5, Infinity])
    assert.throws(() => queueDelaySeconds(delay));
  const delivery = queueDelivery("probe-jobs", payloads());
  assert.throws(() => delivery.batch.retryAll({ delaySeconds: -1 }));
  assert.throws(() => delivery.batch.messages[0]!.retry({ delaySeconds: -1 }));
  delivery.batch.retryAll();
  assert.deepEqual(
    delivery.finish(true),
    payloads().map(() => ({ action: "retry" })),
  );
});
