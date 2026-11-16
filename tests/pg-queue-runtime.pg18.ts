import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client, Pool } from "pg";
import ts from "typescript";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgQueueTransport, type PgQueueName } from "../src/pg-queue.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = readFileSync(
  new URL("../migrations/postgres/0026_jobs.sql", import.meta.url),
  "utf8",
);
const limits = {
  maxMessages: 1000,
  maxBytes: 1000000,
  leaseMilliseconds: 60000,
  executionTimeoutMillis: 30000,
  drainTimeoutMillis: 1000,
};
let runtime: PgStoreRuntime;
let queue: Awaited<ReturnType<typeof createPgQueueTransport>>;
const transports: (typeof queue)[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = (name: PgQueueName) =>
  control.query(
    "UPDATE jobs.messages SET available_at_ms=available_at_ms-60000 WHERE queue=$1",
    [name],
  );
const peer = async () => {
  const next = await createPgQueueTransport(runtime, limits);
  transports.push(next);
  return next;
};

describe("durable PostgreSQL queue transport", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    runtime = createPgStoreRuntime({
      connectionString,
      maxConnections: 4,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError: (error) => {
        throw error;
      },
    });
  });
  beforeEach(async () => {
    await Promise.all(
      transports.splice(0).map((transport) => transport.close()),
    );
    await control.query("DROP SCHEMA IF EXISTS jobs CASCADE");
    await control.query(migration);
    queue = await peer();
  });
  after(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
    await runtime.close();
    try {
      await control.query("DROP SCHEMA IF EXISTS jobs CASCADE");
    } finally {
      await control.end();
    }
  });

  it("keeps all six current consumer policies identical to their Wrangler declarations", async () => {
    type Consumer = {
      queue: string;
      max_batch_size: number;
      max_batch_timeout: number;
      max_retries: number;
      max_concurrency: number;
      retry_delay?: number;
      dead_letter_queue?: string;
    };
    const consumers = ["wrangler.jsonc", "wrangler.data.jsonc"].flatMap(
      (name) => {
        const result = ts.parseConfigFileTextToJson(
          name,
          readFileSync(new URL(`../${name}`, import.meta.url), "utf8"),
        );
        assert.equal(result.error, undefined);
        return (result.config as { queues: { consumers: Consumer[] } }).queues
          .consumers;
      },
    );
    const rows = (
      await control.query("SELECT * FROM jobs.queues ORDER BY name")
    ).rows;
    assert.equal(rows.length, 6);
    for (const row of rows) {
      const source = consumers.find((consumer) => consumer.queue === row.name)!;
      assert.ok(source);
      assert.deepEqual(row, {
        name: source.queue,
        max_batch_size: source.max_batch_size,
        max_batch_timeout: source.max_batch_timeout,
        max_retries: source.max_retries,
        max_concurrency: source.max_concurrency,
        retry_delay: source.retry_delay ?? 0,
        dead_letter_queue: source.dead_letter_queue ?? null,
      });
    }
  });

  it("enforces READ COMMITTED even when the connection defaults to REPEATABLE READ", async () => {
    const configured = createPgStoreRuntime(
      {
        connectionString,
        maxConnections: 2,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError() {},
      },
      (config) =>
        new Pool({
          ...config,
          options: "-c default_transaction_isolation=repeatable\\ read",
        }),
    );
    try {
      const defaults = await configured.read.first<{ isolation: string }>(
        "SELECT current_setting('default_transaction_isolation') AS isolation",
      );
      assert.equal(defaults!.isolation, "repeatable read");
      const isolation = await configured.transaction(
        (tx) =>
          tx.first<{ isolation: string }>(
            "SELECT current_setting('transaction_isolation') AS isolation",
          ),
        { isolation: "read committed" },
      );
      assert.equal(isolation!.isolation, "read committed");
      const transport = await createPgQueueTransport(configured, limits);
      await transport.binding("probe-jobs").send({});
      await flush("probe-jobs");
      assert.equal(
        (await transport.run("probe-jobs", async () => {})).acknowledged,
        1,
      );
      await transport.close();
    } finally {
      await configured.close();
    }
  });

  it("preserves JSON, signed embedded text, NUL text and binary bodies without coercing bytes", async () => {
    const signed = '{ "type":"event", "escaped":"\\u0041", "z":1 }\n';
    await queue
      .binding("webhook-deliveries")
      .sendBatch([
        { body: { body: signed } },
        { body: "a\u0000b", contentType: "text" },
        { body: Uint8Array.of(0, 255, 128).buffer, contentType: "bytes" },
      ]);
    const stored = (
      await control.query("SELECT content_type,body FROM jobs.messages")
    ).rows;
    assert.ok(
      stored.some((row) => row.body.equals(Buffer.from([0, 255, 128]))),
    );
    await flush("webhook-deliveries");
    await queue.run("webhook-deliveries", async (batch) => {
      assert.equal(batch.messages.length, 3);
      assert.equal(batch.metadata.metrics.backlogCount, 0);
      assert.equal(batch.metadata.metrics.oldestMessageTimestamp, undefined);
      const bodies = batch.messages.map((message) => message.body);
      assert.ok(
        bodies.some((body) => (body as { body?: string }).body === signed),
      );
      assert.ok(bodies.includes("a\u0000b"));
      assert.ok(
        bodies.some(
          (body) =>
            body instanceof ArrayBuffer &&
            Buffer.from(body).equals(Buffer.from([0, 255, 128])),
        ),
      );
    });
    assert.equal(
      (await queue.binding("webhook-deliveries").metrics()).backlogCount,
      0,
    );
    assert.equal(
      (
        await control.query(
          "SELECT message_count,body_bytes FROM jobs.capacity",
        )
      ).rows[0].body_bytes,
      0,
    );
  });

  it("serializes concurrent producers at the shared capacity bound without partial sends", async () => {
    await queue.close();
    await control.query("DELETE FROM jobs.capacity");
    const bounded = { ...limits, maxMessages: 2, maxBytes: 10 };
    const first = await createPgQueueTransport(runtime, bounded);
    const second = await createPgQueueTransport(runtime, bounded);
    transports.push(first, second);
    const outcomes = await Promise.allSettled([
      first.binding("probe-jobs").send("123456", { contentType: "text" }),
      second.binding("sync-batches").send("123456", { contentType: "text" }),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      (await control.query("SELECT count(*)::int AS n FROM jobs.messages"))
        .rows[0].n,
      1,
    );
    assert.deepEqual(
      (
        await control.query(
          "SELECT message_count,body_bytes FROM jobs.capacity",
        )
      ).rows[0],
      { message_count: 1, body_bytes: 6 },
    );
    await assert.rejects(
      first.binding("probe-jobs").sendBatch([
        { body: "123", contentType: "text" },
        { body: "123", contentType: "text" },
      ]),
    );
    assert.equal(
      (await control.query("SELECT count(*)::int AS n FROM jobs.messages"))
        .rows[0].n,
      1,
    );
  });

  it("allows only the declared concurrent batches across independent transport instances", async () => {
    const second = await peer();
    const third = await peer();
    await queue
      .binding("probe-jobs")
      .sendBatch(Array.from({ length: 10 }, (_, n) => ({ body: n })));
    const entered = [deferred(), deferred()];
    const finish = deferred();
    const ids: string[][] = [];
    const running = [queue, second].map((transport, i) =>
      transport.run("probe-jobs", async (batch) => {
        ids[i] = batch.messages.map((message) => message.id);
        entered[i]!.resolve();
        await finish.promise;
      }),
    );
    await Promise.all(entered.map((event) => event.promise));
    assert.equal(new Set(ids.flat()).size, 10);
    assert.equal(
      (
        await third.run("probe-jobs", async () => {
          throw new Error("must not invoke");
        })
      ).status,
      "capacity",
    );
    finish.resolve();
    await Promise.all(running);
    assert.equal(
      (await control.query("SELECT count(*)::int AS n FROM jobs.messages"))
        .rows[0].n,
      0,
    );
  });

  it("preserves explicit ack while defaulting a thrown handler to retry its other messages", async () => {
    await queue
      .binding("sync-batches")
      .sendBatch([{ body: "ack" }, { body: "retry" }]);
    await flush("sync-batches");
    const error = new Error("injected handler failure");
    await assert.rejects(
      queue.run("sync-batches", async (batch) => {
        batch.messages.find((message) => message.body === "ack")!.ack();
        throw error;
      }),
      (failure) => failure === error,
    );
    const stored = (
      await control.query("SELECT body,attempts,delivery_id FROM jobs.messages")
    ).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].body.toString(), '"retry"');
    assert.equal(stored[0].attempts, 1);
    assert.equal(stored[0].delivery_id, null);
  });

  it("rolls back partial settlement and redelivers after a failed acknowledgment transaction", async () => {
    let deletions = 0;
    let armed = false;
    const failure = new Error("injected settlement failure");
    const broken = await createPgQueueTransport(
      {
        transaction: (callback, options) =>
          runtime.transaction(
            (tx) =>
              callback({
                ...tx,
                run: (text, values) => {
                  if (
                    armed &&
                    text.startsWith("DELETE FROM jobs.messages") &&
                    ++deletions === 2
                  )
                    throw failure;
                  return tx.run(text, values);
                },
              }),
            options,
          ),
      },
      limits,
    );
    transports.push(broken);
    await broken.binding("probe-jobs").sendBatch([{ body: 1 }, { body: 2 }]);
    await flush("probe-jobs");
    armed = true;
    await assert.rejects(
      broken.run("probe-jobs", async () => {}),
      (error) => error === failure,
    );
    assert.equal(
      (await control.query("SELECT count(*)::int AS n FROM jobs.messages"))
        .rows[0].n,
      2,
    );
    assert.equal(
      (await control.query("SELECT message_count FROM jobs.capacity")).rows[0]
        .message_count,
      2,
    );
    await control.query("UPDATE jobs.deliveries SET expires_at_ms=0");
    await queue.run("probe-jobs", async (batch) => {
      assert.ok(batch.messages.every((message) => message.attempts === 2));
    });
    assert.equal(
      (await control.query("SELECT count(*)::int AS n FROM jobs.messages"))
        .rows[0].n,
      0,
    );
  });

  it("fences a stale handler after another claimant owns the expired delivery", async () => {
    await queue.binding("probe-jobs").send({ exact: "body" });
    await flush("probe-jobs");
    const entered = deferred();
    const finish = deferred();
    const old = queue.run("probe-jobs", async (batch) => {
      batch.ackAll();
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    await control.query("UPDATE jobs.deliveries SET expires_at_ms=0");
    const second = await peer();
    await second.run("probe-jobs", async (batch) => {
      assert.equal(batch.messages[0]!.attempts, 2);
      batch.retryAll({ delaySeconds: 30 });
    });
    finish.resolve();
    await assert.rejects(old, /no longer owned/);
    const stored = (
      await control.query("SELECT body,attempts FROM jobs.messages")
    ).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].body.toString(), '{"exact":"body"}');
    assert.equal(stored[0].attempts, 2);
  });

  it(
    "bounds a hung consumer and reports an unfinished drain until it exits",
    { timeout: 3000 },
    async () => {
      const bounded = await createPgQueueTransport(runtime, {
        ...limits,
        leaseMilliseconds: 5000,
        executionTimeoutMillis: 100,
        drainTimeoutMillis: 100,
      });
      transports.push(bounded);
      await bounded.binding("probe-jobs-dlq").send({});
      await flush("probe-jobs-dlq");
      const entered = deferred();
      const finish = deferred();
      let signal!: AbortSignal;
      try {
        const running = bounded.run(
          "probe-jobs-dlq",
          async (_batch, received) => {
            signal = received;
            entered.resolve();
            await finish.promise;
          },
        );
        const rejected = assert.rejects(running, /execution deadline/);
        await entered.promise;
        await rejected;
        assert.equal(signal.aborted, true);
        await assert.rejects(bounded.close(), /drain deadline/);
        assert.equal(bounded.state, "closing");
        finish.resolve();
        await bounded.close();
        assert.equal(bounded.state, "closed");
      } finally {
        finish.resolve();
      }
    },
  );

  it("moves exhausted work to its DLQ and parks failed terminal custody without data loss", async () => {
    await queue.binding("probe-jobs").send({ exact: "payload" });
    const original = (
      await control.query("SELECT id,body,created_at_ms FROM jobs.messages")
    ).rows[0];
    for (let n = 1; n <= 4; n++) {
      await flush("probe-jobs");
      await queue.run("probe-jobs", async (batch) => batch.retryAll());
    }
    const dead = (
      await control.query(
        "SELECT id,body,created_at_ms,queue,original_attempts FROM jobs.messages",
      )
    ).rows[0];
    assert.equal(dead.queue, "probe-jobs-dlq");
    assert.equal(dead.original_attempts, 4);
    assert.equal(dead.id, original.id);
    assert.equal(dead.created_at_ms, original.created_at_ms);
    assert.deepEqual(dead.body, original.body);
    await flush("probe-jobs-dlq");
    const result = await queue.run("probe-jobs-dlq", async (batch) =>
      batch.retryAll(),
    );
    assert.equal(result.parked, 1);
    const retained = (
      await control.query("SELECT state,body FROM jobs.messages")
    ).rows[0];
    assert.equal(retained.state, "parked");
    assert.deepEqual(retained.body, original.body);
    assert.equal(
      (await control.query("SELECT message_count FROM jobs.capacity")).rows[0]
        .message_count,
      1,
    );
  });
});
