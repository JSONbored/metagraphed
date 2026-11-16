import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createPgQueueTransport, type PgQueueName } from "../src/pg-queue.ts";
import { queueDeferred, queueFixture } from "./helpers/queue-fixture.ts";

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
const rows = async () =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM jobs.messages ORDER BY id",
    )
  ).rows;

test("requires finite capacity, matching source policy and active enforcement", async () => {
  for (const [key, values] of Object.entries({
    maxMessages: [0, 100001, 0.1],
    maxBytes: [0, 1073741825, Infinity],
    leaseMilliseconds: [0, 3600001, NaN],
    executionTimeoutMillis: [0, 3600001, NaN],
    drainTimeoutMillis: [0, 3600001, NaN],
  }))
    for (const value of values)
      await assert.rejects(
        createPgQueueTransport(fixture.runtime, {
          ...fixture.limits,
          [key]: value,
        }),
        /Invalid queue/,
      );
  await assert.rejects(
    createPgQueueTransport(fixture.runtime, {
      ...fixture.limits,
      executionTimeoutMillis: fixture.limits.leaseMilliseconds,
    }),
    /precede lease expiry/,
  );
  await assert.rejects(
    createPgQueueTransport(fixture.runtime, {
      ...fixture.limits,
      maxMessages: 2,
    }),
    /configuration differs/,
  );
  await db.exec(
    "ALTER TABLE jobs.messages DISABLE TRIGGER queue_payload_immutable",
  );
  await assert.rejects(
    createPgQueueTransport(fixture.runtime, fixture.limits),
    /not activated/,
  );
  await assert.rejects(
    fixture.transport.binding("probe-jobs").send({}),
    /not activated/,
  );
  await db.exec(
    "ALTER TABLE jobs.messages ENABLE TRIGGER queue_payload_immutable",
  );
  await db.exec(
    "UPDATE jobs.queues SET max_batch_size=1 WHERE name='probe-jobs'",
  );
  await assert.rejects(
    createPgQueueTransport(fixture.runtime, fixture.limits),
    /policy inventory/,
  );
  await db.exec(
    "UPDATE jobs.queues SET max_batch_size=5 WHERE name='probe-jobs'; DELETE FROM jobs.queues WHERE name='probe-jobs'",
  );
  await assert.rejects(
    createPgQueueTransport(fixture.runtime, fixture.limits),
    /policy inventory/,
  );
  await db.exec("INSERT INTO jobs.queues VALUES ('unknown',5,15,3,2,0,NULL)");
  await assert.rejects(
    createPgQueueTransport(fixture.runtime, fixture.limits),
    /policy inventory/,
  );
});

test("refuses missing capacity and altered lease membership before acknowledging anything", async () => {
  await db.exec("DELETE FROM jobs.capacity");
  await assert.rejects(
    fixture.transport.binding("probe-jobs").metrics(),
    /configuration differs/,
  );
  fixture = await queueFixture(db);
  await fixture.transport
    .binding("probe-jobs")
    .sendBatch([{ body: 1 }, { body: 2 }]);
  await fixture.flush("probe-jobs");
  const entered = queueDeferred();
  const finish = queueDeferred();
  const running = fixture.transport.run("probe-jobs", async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  await db.exec(
    "DELETE FROM jobs.messages WHERE id=(SELECT id FROM jobs.messages LIMIT 1)",
  );
  finish.resolve();
  await assert.rejects(running, /membership differs/);
  assert.equal((await rows()).length, 1);
});

test("preserves JSON embedded signed text and independently restores text/bytes deliveries", async () => {
  const queue = fixture.transport.binding("webhook-deliveries");
  const signed = '{ "z": "\\u0041", "a": 1 }\n';
  const send = await queue.sendBatch([
    { body: { body: signed, event_id: "e" } },
    { body: "plain\u0000text", contentType: "text" },
    { body: Uint8Array.of(0, 128, 255).buffer, contentType: "bytes" },
  ]);
  assert.equal(send.metadata.metrics.backlogCount, 3);
  assert.ok(send.metadata.metrics.oldestMessageTimestamp instanceof Date);
  assert.equal((await queue.metrics()).backlogCount, 3);
  await fixture.flush("webhook-deliveries");
  await fixture.transport.run("webhook-deliveries", async (batch) => {
    const bodies = batch.messages.map((message) => message.body);
    assert.ok(
      bodies.some((body) => (body as { body?: string }).body === signed),
    );
    assert.ok(bodies.includes("plain\u0000text"));
    assert.ok(
      bodies.some(
        (body) =>
          body instanceof ArrayBuffer &&
          Buffer.from(body).equals(Buffer.from([0, 128, 255])),
      ),
    );
    for (const message of batch.messages) {
      assert.equal(message.attempts, 1);
      assert.ok(message.timestamp instanceof Date);
    }
  });
  assert.equal((await queue.metrics()).oldestMessageTimestamp, undefined);
});

test("validates bodies, batch totals, finite iterables and send delays before any insertion", async () => {
  const queue = fixture.transport.binding("probe-jobs");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const [body, options] of [
    [undefined, undefined],
    [1n, undefined],
    [cycle, undefined],
    [1, { contentType: "text" }],
    ["bytes", { contentType: "bytes" }],
    ["x", { contentType: "v8" }],
    ["x".repeat(131073), { contentType: "text" }],
  ] as const)
    await assert.rejects(queue.send(body, options as never));
  await assert.rejects(queue.send({}, { delaySeconds: -1 }));
  await assert.rejects(
    queue.sendBatch(Array.from({ length: 101 }, () => ({ body: {} }))),
    /100 messages/,
  );
  await assert.rejects(
    queue.sendBatch(
      Array.from({ length: 3 }, () => ({
        body: "x".repeat(100000),
        contentType: "text",
      })),
    ),
    /256 KiB/,
  );
  await assert.rejects(
    queue.sendBatch([{ body: {} }], { delaySeconds: 86401 }),
  );
  assert.equal((await rows()).length, 0);
  assert.throws(
    () => fixture.transport.binding("unknown" as PgQueueName),
    /Unknown/,
  );
  await queue.sendBatch([{ body: "batch" }, { body: "own", delaySeconds: 0 }], {
    delaySeconds: 60,
  });
  const stored = await rows();
  const delays = stored
    .map((row) => Number(row.available_at_ms) - Number(row.created_at_ms))
    .sort((a, b) => a - b);
  assert.deepEqual(delays, [0, 60000]);
});

test("enforces aggregate message and byte bounds atomically and releases space only on acknowledgment", async () => {
  fixture = await queueFixture(db, {
    ...fixture.limits,
    maxMessages: 2,
    maxBytes: 10,
  });
  const queue = fixture.transport.binding("probe-jobs");
  await assert.rejects(
    queue.sendBatch([
      { body: "123456", contentType: "text" },
      { body: "123456", contentType: "text" },
    ]),
    /constraint/,
  );
  assert.equal((await rows()).length, 0);
  await queue.sendBatch([
    { body: "12345", contentType: "text" },
    { body: "12345", contentType: "text" },
  ]);
  await assert.rejects(queue.send(""), /constraint/);
  await fixture.flush("probe-jobs");
  const result = await fixture.transport.run("probe-jobs", async (batch) => {
    batch.messages[0]!.ack();
    batch.messages[1]!.retry();
  });
  assert.equal(result.acknowledged, 1);
  assert.equal(result.retried, 1);
  await queue.send("12345", { contentType: "text" });
  assert.equal((await rows()).length, 2);
  await assert.rejects(
    db.exec("UPDATE jobs.messages SET body=decode('ff','hex')"),
    /immutable/,
  );
});

test("does not invoke an empty/delayed/underfilled batch and permits explicit send overrides", async () => {
  const queue = fixture.transport.binding("probe-jobs");
  const consume = async () => {
    throw new Error("must not run");
  };
  assert.equal(
    (await fixture.transport.run("probe-jobs", consume)).status,
    "empty",
  );
  await queue.send({}, { delaySeconds: 86400 });
  assert.equal(
    (await fixture.transport.run("probe-jobs", consume)).status,
    "empty",
  );
  await queue.send({});
  assert.equal(
    (await fixture.transport.run("probe-jobs", consume)).status,
    "waiting",
  );
  await fixture.flush("probe-jobs");
  assert.equal(
    (await fixture.transport.run("probe-jobs", async () => {})).acknowledged,
    1,
  );
});

test("retries unacknowledged failures but preserves every explicit message and batch disposition", async () => {
  const queue = fixture.transport.binding("probe-jobs");
  await queue.sendBatch([1, 2, 3].map((body) => ({ body })));
  await fixture.flush("probe-jobs");
  const error = new Error("handler failed");
  await assert.rejects(
    fixture.transport.run("probe-jobs", async (batch) => {
      const byBody = (id: number) =>
        batch.messages.find((message) => message.body === id)!;
      byBody(1).ack();
      byBody(2).retry({ delaySeconds: 50 });
      throw error;
    }),
    (failure) => failure === error,
  );
  const stored = await rows();
  assert.equal(stored.length, 2);
  assert.ok(stored.every((row) => row.attempts === 1));
  assert.ok(
    stored.some((row) => Number(row.available_at_ms) > Date.now() + 40000),
  );
  await fixture.flush("probe-jobs");
  await fixture.transport.run("probe-jobs", async (batch) => {
    batch.ackAll();
    batch.messages[0]!.retry();
  });
  assert.equal((await rows()).length, 1);
});

test("retry exhaustion retains original payload/id/time in the DLQ and preserves terminal DLQ custody", async () => {
  const queue = fixture.transport.binding("probe-jobs");
  await queue.send({ exact: "payload" });
  const original = (await rows())[0]!;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await fixture.flush("probe-jobs");
    const result = await fixture.transport.run("probe-jobs", async (batch) => {
      assert.equal(batch.messages[0]!.attempts, attempt);
      batch.retryAll();
    });
    assert.equal(result[attempt === 4 ? "deadLettered" : "retried"], 1);
  }
  const dlq = (await rows())[0]!;
  assert.equal(dlq.queue, "probe-jobs-dlq");
  assert.equal(dlq.id, original.id);
  assert.deepEqual(dlq.body, original.body);
  assert.equal(dlq.created_at_ms, original.created_at_ms);
  assert.equal(dlq.original_attempts, 4);
  assert.equal(dlq.attempts, 0);
  await fixture.flush("probe-jobs-dlq");
  const result = await fixture.transport.run("probe-jobs-dlq", async (batch) =>
    batch.retryAll(),
  );
  assert.equal(result.parked, 1);
  assert.equal((await rows())[0]!.state, "parked");
  assert.equal(
    (await fixture.transport.run("probe-jobs-dlq", async () => {})).status,
    "empty",
  );
});

test("default retry delay survives without an explicit override", async () => {
  await fixture.transport.binding("sync-batches-dlq").send({});
  await fixture.flush("sync-batches-dlq");
  await fixture.transport.run("sync-batches-dlq", async (batch) =>
    batch.retryAll(),
  );
  const row = (await rows())[0]!;
  assert.ok(Number(row.available_at_ms) > Date.now() + 590000);
});

test("leases fence stale completion, recover exhausted work and bound cross-instance concurrency", async () => {
  const queue = fixture.transport.binding("probe-jobs");
  await queue.send({});
  await fixture.flush("probe-jobs");
  const entered = queueDeferred();
  const finish = queueDeferred();
  const old = fixture.transport.run("probe-jobs", async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  await db.exec("UPDATE jobs.deliveries SET expires_at_ms=0");
  const second = await createPgQueueTransport(fixture.runtime, fixture.limits);
  const reclaimed = await second.run("probe-jobs", async (batch) => {
    assert.equal(batch.messages[0]!.attempts, 2);
    batch.ackAll();
  });
  assert.equal(reclaimed.acknowledged, 1);
  finish.resolve();
  await assert.rejects(old, /no longer owned/);
  await queue.send({});
  await fixture.flush("probe-jobs");
  const lastEntered = queueDeferred();
  const lastFinish = queueDeferred();
  const abandoned = fixture.transport.run("probe-jobs", async () => {
    lastEntered.resolve();
    await lastFinish.promise;
  });
  await lastEntered.promise;
  await db.exec(
    "UPDATE jobs.messages SET attempts=4; UPDATE jobs.deliveries SET expires_at_ms=0",
  );
  assert.equal(
    (
      await second.run("probe-jobs", async () => {
        throw new Error("exhausted messages must not run");
      })
    ).status,
    "empty",
  );
  assert.equal((await rows())[0]!.queue, "probe-jobs-dlq");
  lastFinish.resolve();
  await assert.rejects(abandoned, /no longer owned/);
});

test("bounds both local and cross-process active batch claims", async () => {
  await fixture.transport
    .binding("probe-jobs")
    .sendBatch(Array.from({ length: 10 }, (_, body) => ({ body })));
  const entered = [queueDeferred(), queueDeferred()];
  const finish = queueDeferred();
  const jobs = entered.map((event) =>
    fixture.transport.run("probe-jobs", async () => {
      event.resolve();
      await finish.promise;
    }),
  );
  await Promise.all(entered.map((event) => event.promise));
  assert.equal(
    (await fixture.transport.run("probe-jobs", async () => {})).status,
    "capacity",
  );
  const peer = await createPgQueueTransport(fixture.runtime, fixture.limits);
  assert.equal(
    (await peer.run("probe-jobs", async () => {})).status,
    "capacity",
  );
  finish.resolve();
  await Promise.all(jobs);
});

test("a closing transport drains its admitted delivery and rejects new work without closing the pool", async () => {
  await fixture.transport.binding("probe-jobs").send({});
  await fixture.flush("probe-jobs");
  const entered = queueDeferred();
  const finish = queueDeferred();
  const running = fixture.transport.run("probe-jobs", async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const closing = fixture.transport.close();
  assert.equal(closing, fixture.transport.close());
  await assert.rejects(
    fixture.transport.binding("probe-jobs").send({}),
    /closed/,
  );
  await assert.rejects(
    fixture.transport.run("probe-jobs", async () => {}),
    /closed/,
  );
  finish.resolve();
  await Promise.all([running, closing]);
  assert.equal((await db.query("SELECT 1 AS alive")).rows.length, 1);
});

test("execution deadline aborts and freezes decisions while preserving acknowledged work", async () => {
  fixture = await queueFixture(db, {
    ...fixture.limits,
    leaseMilliseconds: 1000,
    executionTimeoutMillis: 10,
    drainTimeoutMillis: 10,
  });
  await fixture.transport
    .binding("probe-jobs")
    .sendBatch([{ body: "ack" }, { body: "retry" }]);
  await fixture.flush("probe-jobs");
  const entered = queueDeferred();
  const finish = queueDeferred();
  let signal!: AbortSignal;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const running = fixture.transport.run(
      "probe-jobs",
      async (batch, received) => {
        signal = received;
        signal.addEventListener("abort", () => batch.ackAll(), { once: true });
        batch.messages.find((message) => message.body === "ack")!.ack();
        entered.resolve();
        await finish.promise;
        batch.ackAll();
      },
    );
    const rejected = assert.rejects(running, /execution deadline/);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal((await rows()).length, 1);
    assert.equal(
      Buffer.from((await rows())[0]!.body as Uint8Array).toString(),
      '"retry"',
    );
    finish.resolve();
    await Promise.resolve();
    await fixture.transport.close();
  } finally {
    finish.resolve();
    vi.useRealTimers();
  }
});

test("a hung consumer retains its slot and bounded close reports unfinished work", async () => {
  fixture = await queueFixture(db, {
    ...fixture.limits,
    leaseMilliseconds: 1000,
    executionTimeoutMillis: 10,
    drainTimeoutMillis: 10,
  });
  const binding = fixture.transport.binding("probe-jobs-dlq");
  await binding.send({});
  await fixture.flush("probe-jobs-dlq");
  const entered = queueDeferred();
  const finish = queueDeferred();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const running = fixture.transport.run("probe-jobs-dlq", async () => {
      entered.resolve();
      await finish.promise;
    });
    const rejected = assert.rejects(running, /execution deadline/);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await binding.send({});
    await fixture.flush("probe-jobs-dlq");
    assert.equal(
      (await fixture.transport.run("probe-jobs-dlq", async () => {})).status,
      "capacity",
    );
    const closing = fixture.transport.close();
    const drainRejected = assert.rejects(closing, /drain deadline/);
    await vi.advanceTimersByTimeAsync(10);
    await drainRejected;
    assert.equal(fixture.transport.state, "closing");
    finish.resolve();
    await Promise.resolve();
    await fixture.transport.close();
    assert.equal(fixture.transport.state, "closed");
  } finally {
    finish.resolve();
    vi.useRealTimers();
  }
});

test("a claim that completes after the drain deadline never starts its consumer", async () => {
  fixture = await queueFixture(db, {
    ...fixture.limits,
    leaseMilliseconds: 1000,
    executionTimeoutMillis: 100,
    drainTimeoutMillis: 10,
  });
  assert.equal(fixture.transport.state, "ready");
  await fixture.transport.binding("probe-jobs").send({});
  await fixture.flush("probe-jobs");
  const original = fixture.runtime.transaction;
  const entered = queueDeferred();
  const release = queueDeferred();
  let blocked = true;
  let invoked = false;
  fixture.runtime.transaction = async (callback, options) => {
    if (blocked) {
      blocked = false;
      entered.resolve();
      await release.promise;
    }
    return original(callback, options);
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const running = fixture.transport.run("probe-jobs", async () => {
      invoked = true;
    });
    const runRejected = assert.rejects(running, /drain deadline/);
    await entered.promise;
    const drainRejected = assert.rejects(
      fixture.transport.close(),
      /drain deadline/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await drainRejected;
    release.resolve();
    await runRejected;
    assert.equal(invoked, false);
    assert.equal((await rows()).length, 1);
    await fixture.transport.close();
    assert.equal(fixture.transport.state, "closed");
  } finally {
    release.resolve();
    fixture.runtime.transaction = original;
    vi.useRealTimers();
  }
});
