import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { apiEnv, dataApiEnv } from "./helpers/worker-env.ts";
import { queueFixture } from "./helpers/queue-fixture.ts";
import { createPgQueueDispatcher } from "../src/pg-queue.ts";
import { consumeBatch } from "../src/lane-queue.ts";

// These tests invoke the real Worker consumers, with no inherited fetch mocks.
vi.resetModules();
const { default: api, handleWebhookQueue } = await import("../workers/api.ts");
const { default: data } = await import("../workers/data-api.ts");
let db: PGlite;
let fixture: Awaited<ReturnType<typeof queueFixture>>;
beforeAll(async () => {
  db = new PGlite();
});
beforeEach(async () => {
  fixture = await queueFixture(db);
});
afterAll(async () => {
  await db.close();
});
function context() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (value: Promise<unknown>) => pending.push(value),
    } as unknown as ExecutionContext,
    drain: () => Promise.all(pending),
  };
}

test("real probe and sync consumers retain malformed-body acknowledgments", async () => {
  for (const queue of ["probe-jobs", "sync-batches"] as const) {
    await fixture.transport.binding(queue).send({ unexpected: "shape" });
    await fixture.flush(queue);
    const task = context();
    const dispatcher = createPgQueueDispatcher(fixture.transport, {
      api: {
        queue: async (batch) => {
          await api.queue(batch, apiEnv(), task.ctx);
          await task.drain();
        },
      },
      data: {
        queue: async (batch) => {
          await data.queue(batch, dataApiEnv(), task.ctx);
          await task.drain();
        },
      },
    });
    const result = await dispatcher.run(queue);
    assert.equal(result.acknowledged, 1);
  }
});

test("real sync writer refusal retries the original message instead of acknowledging it", async () => {
  const body = {
    lane: "hotkey-alpha",
    captured_at: 1000,
    rows: [{ hotkey: "fixture", alpha: "1" }],
  };
  await fixture.transport.binding("sync-batches").send(body);
  await fixture.flush("sync-batches");
  const task = context();
  const result = await fixture.transport.run("sync-batches", async (batch) => {
    await data.queue(batch, dataApiEnv(), task.ctx);
    await task.drain();
  });
  assert.equal(result.retried, 1);
  const saved = (
    await db.query<{ body: Uint8Array }>("SELECT body FROM jobs.messages")
  ).rows[0]!;
  assert.equal(Buffer.from(saved.body).toString(), JSON.stringify(body));
});

test("actual webhook consumer receives unchanged signed text and owns retry delay/terminal ack", async () => {
  const raw = '{ "type": "metagraph.publish", "z": 2, "a": "\\u0041" }\n';
  const queue = fixture.transport.binding("webhook-deliveries");
  await queue.send({ subscription_id: "s", event_id: "e", body: raw });
  const env = apiEnv({
    METAGRAPH_CONTROL: { get: async () => ({ id: "s" }), put: async () => {} },
  });
  const task = context();
  await fixture.flush("webhook-deliveries");
  const retry = await fixture.transport.run("webhook-deliveries", (batch) =>
    handleWebhookQueue(batch, env, task.ctx, async (input) => {
      assert.equal(input.bodyText, raw);
      assert.equal(input.maxAttempts, 1);
      return { status: "failed", retryable: true };
    }),
  );
  assert.equal(retry.retried, 1);
  const saved = (
    await db.query<{ available_at_ms: string; attempts: number }>(
      "SELECT available_at_ms,attempts FROM jobs.messages",
    )
  ).rows[0]!;
  assert.ok(Number(saved.available_at_ms) > Date.now() + 290000);
  assert.equal(saved.attempts, 1);
  await fixture.flush("webhook-deliveries");
  await db.exec("UPDATE jobs.messages SET available_at_ms=0");
  const terminal = await fixture.transport.run("webhook-deliveries", (batch) =>
    handleWebhookQueue(batch, env, task.ctx, async (input) => {
      assert.equal(input.bodyText, raw);
      return { status: "failed", retryable: false };
    }),
  );
  assert.equal(terminal.acknowledged, 1);
});

test("actual sync dead-letter consumer retries custody when its durable store is unavailable", async () => {
  await fixture.transport.binding("sync-batches-dlq").send({
    lane: "hotkey-alpha",
    captured_at: 1000,
    rows: [{ hotkey: "fixture" }],
  });
  await fixture.flush("sync-batches-dlq");
  const task = context();
  const dispatcher = createPgQueueDispatcher(fixture.transport, {
    api: {
      queue: async () => {
        throw new Error("Sync DLQ routed to the wrong consumer");
      },
    },
    data: {
      queue: async (batch) => {
        await data.queue(batch, dataApiEnv(), task.ctx);
        await task.drain();
      },
    },
  });
  const result = await dispatcher.run("sync-batches-dlq");
  assert.equal(result.retried, 1);
  const saved = (
    await db.query<{ available_at_ms: string }>(
      "SELECT available_at_ms FROM jobs.messages",
    )
  ).rows[0]!;
  assert.ok(Number(saved.available_at_ms) > Date.now() + 590000);
});

test("the shared lane consumer keeps successes, permanent drops and transient retries distinct", async () => {
  await fixture.transport
    .binding("probe-jobs")
    .sendBatch([1, 2, null].map((body) => ({ body })));
  await fixture.flush("probe-jobs");
  const result = await fixture.transport.run("probe-jobs", async (batch) => {
    const outcome = await consumeBatch([...batch.messages], {
      parse: (body) => (typeof body === "number" ? body : null),
      run: async (body) => body === 1,
      onRetry() {},
    });
    assert.deepEqual(outcome, {
      done: 1,
      retried: 1,
      dropped: 1,
      firstFailure: "run() declined without throwing",
    });
  });
  assert.equal(result.acknowledged, 2);
  assert.equal(result.retried, 1);
});
