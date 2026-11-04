import { randomUUID } from "node:crypto";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";
import {
  queueDelaySeconds,
  queueDelivery,
  type QueueDecision,
} from "./queue-delivery.ts";

export const PG_QUEUE_NAMES = [
  "probe-jobs",
  "webhook-deliveries",
  "sync-batches",
  "probe-jobs-dlq",
  "webhook-deliveries-dlq",
  "sync-batches-dlq",
] as const;
export type PgQueueName = (typeof PG_QUEUE_NAMES)[number];
type ContentType = "json" | "text" | "bytes";
export interface PgQueueSendOptions {
  contentType?: ContentType | "v8";
  delaySeconds?: number;
}
export interface PgQueueSendRequest extends PgQueueSendOptions {
  body: unknown;
}
export interface PgQueueLimits {
  maxMessages: number;
  maxBytes: number;
  leaseMilliseconds: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
}
interface Policy {
  name: PgQueueName;
  max_batch_size: number;
  max_batch_timeout: number;
  max_retries: number;
  max_concurrency: number;
  retry_delay: number;
  dead_letter_queue: PgQueueName | null;
}
interface StoredMessage {
  id: string;
  body: Uint8Array;
  content_type: ContentType;
  created_at_ms: string | number;
  available_at_ms: string | number;
  attempts: number;
}
export interface PgQueueRunResult {
  status: "empty" | "waiting" | "capacity" | "delivered";
  acknowledged: number;
  retried: number;
  deadLettered: number;
  parked: number;
}
const policyValues = {
  "probe-jobs": [5, 15, 3, 2, 0, "probe-jobs-dlq"],
  "webhook-deliveries": [10, 5, 8, 4, 0, "webhook-deliveries-dlq"],
  "sync-batches": [10, 5, 5, 2, 0, "sync-batches-dlq"],
  "probe-jobs-dlq": [100, 30, 0, 1, 0, null],
  "webhook-deliveries-dlq": [100, 30, 0, 1, 0, null],
  "sync-batches-dlq": [100, 30, 100, 1, 600, null],
} as const;
const emptyResult = (status: PgQueueRunResult["status"]): PgQueueRunResult => ({
  status,
  acknowledged: 0,
  retried: 0,
  deadLettered: 0,
  parked: 0,
});
const nowSql =
  "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now";
const readySql = `SELECT COUNT(*) = 2 AND bool_and(tgenabled IN ('O','A')) AS ready
 FROM pg_catalog.pg_trigger WHERE tgrelid = to_regclass('jobs.messages') AND NOT tgisinternal
 AND tgname IN ('queue_payload_capacity','queue_payload_immutable')`;

function encode(body: unknown, type: ContentType): Buffer {
  let result: Buffer;
  if (type === "json") {
    const text = JSON.stringify(body);
    if (text === undefined)
      throw new TypeError("Queue body must be JSON serializable");
    result = Buffer.from(text, "utf8");
  } else if (type === "text") {
    if (typeof body !== "string")
      throw new TypeError("Text queue bodies must be strings");
    result = Buffer.from(body, "utf8");
  } else if (type === "bytes" && body instanceof ArrayBuffer) {
    result = Buffer.from(new Uint8Array(body));
  } else throw new TypeError("Queue content type does not match its body");
  if (result.length > 131072)
    throw new RangeError("Queue body exceeds 128 KiB");
  return result;
}
function decode(row: StoredMessage): unknown {
  if (row.content_type === "json")
    return JSON.parse(Buffer.from(row.body).toString("utf8"));
  if (row.content_type === "text")
    return Buffer.from(row.body).toString("utf8");
  return Uint8Array.from(row.body).buffer;
}

/** Durable transport only: callers provide the existing application queue handler. */
export async function createPgQueueTransport(
  runtime: Pick<PgStoreRuntime, "transaction">,
  limits: PgQueueLimits,
) {
  for (const [name, value, ceiling] of [
    ["maxMessages", limits.maxMessages, 100000],
    ["maxBytes", limits.maxBytes, 1073741824],
    ["leaseMilliseconds", limits.leaseMilliseconds, 3600000],
    ["executionTimeoutMillis", limits.executionTimeoutMillis, 3600000],
    ["drainTimeoutMillis", limits.drainTimeoutMillis, 3600000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
      throw new RangeError(`Invalid queue ${name}`);
  if (limits.executionTimeoutMillis >= limits.leaseMilliseconds)
    throw new RangeError("Queue execution deadline must precede lease expiry");
  const transact = <T>(operation: (tx: PgTransaction) => Promise<T>) =>
    runtime.transaction(
      async (tx) => {
        // All transport mutations acquire this lock before queue/message locks.
        const capacity = await tx.first<{
          max_messages: string | number;
          max_bytes: string | number;
        }>(
          "SELECT max_messages,max_bytes FROM jobs.capacity WHERE singleton FOR UPDATE",
        );
        if (
          !capacity ||
          Number(capacity.max_messages) !== limits.maxMessages ||
          Number(capacity.max_bytes) !== limits.maxBytes
        )
          throw new Error("Native queue capacity configuration differs");
        if (!(await tx.first<{ ready: boolean }>(readySql))?.ready)
          throw new Error("Native queue schema is not activated");
        return operation(tx);
      },
      { isolation: "read committed" },
    );
  const policies = await runtime.transaction(async (tx) => {
    if (!(await tx.first<{ ready: boolean }>(readySql))?.ready)
      throw new Error("Native queue schema is not activated");
    await tx.run(
      "INSERT INTO jobs.capacity(singleton,max_messages,max_bytes) VALUES (true,?,?) ON CONFLICT(singleton) DO NOTHING",
      [limits.maxMessages, limits.maxBytes],
    );
    const capacity = await tx.first<{
      max_messages: string | number;
      max_bytes: string | number;
    }>(
      "SELECT max_messages,max_bytes FROM jobs.capacity WHERE singleton FOR UPDATE",
    );
    if (
      !capacity ||
      Number(capacity.max_messages) !== limits.maxMessages ||
      Number(capacity.max_bytes) !== limits.maxBytes
    )
      throw new Error("Native queue capacity configuration differs");
    const rows = await tx.query<Policy>(
      "SELECT * FROM jobs.queues ORDER BY name",
    );
    if (
      rows.length !== PG_QUEUE_NAMES.length ||
      rows.some(
        (row) =>
          !PG_QUEUE_NAMES.includes(row.name) ||
          JSON.stringify([
            row.max_batch_size,
            row.max_batch_timeout,
            row.max_retries,
            row.max_concurrency,
            row.retry_delay,
            row.dead_letter_queue,
          ]) !== JSON.stringify(policyValues[row.name]),
      )
    )
      throw new Error("Native queue policy inventory differs");
    return new Map(rows.map((row) => [row.name, row]));
  });
  let open = true;
  const active = new Set<Promise<unknown>>();
  const consumers = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let drained = false;
  let draining: Promise<void> | undefined;
  let drainReason: Error | undefined;
  const running = new Map<PgQueueName, number>();
  let closing: Promise<void> | undefined;
  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!open)
      return Promise.reject(new Error("Native queue transport is closed"));
    const task = operation();
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => {});
    return task;
  };
  const policyFor = (queue: PgQueueName): Policy => {
    const policy = policies.get(queue);
    if (!policy) throw new Error("Unknown native queue");
    return policy;
  };
  const clock = async (tx: PgTransaction) =>
    Number((await tx.first<{ now: string | number }>(nowSql))!.now);
  const metrics = async (tx: PgTransaction, queue: PgQueueName) => {
    const now = await clock(tx);
    const row = await tx.first<{
      count: string;
      bytes: string;
      oldest: string | null;
    }>(
      `SELECT count(*)::text AS count,coalesce(sum(octet_length(m.body)),0)::text AS bytes,min(m.created_at_ms)::text AS oldest
       FROM jobs.messages m LEFT JOIN jobs.deliveries d ON d.id=m.delivery_id
       WHERE m.queue=? AND m.state='pending' AND m.available_at_ms<=?
         AND (d.id IS NULL OR d.expires_at_ms<=?)`,
      [queue, now, now],
    );
    return {
      backlogCount: Number(row!.count),
      backlogBytes: Number(row!.bytes),
      ...(row!.oldest === null
        ? {}
        : { oldestMessageTimestamp: new Date(Number(row!.oldest)) }),
    };
  };
  const enqueue = (
    queue: PgQueueName,
    input: Iterable<PgQueueSendRequest>,
    options?: { delaySeconds?: number },
  ) =>
    admit(async () => {
      policyFor(queue);
      const batchDelay = queueDelaySeconds(options?.delaySeconds);
      const rows: {
        id: string;
        body: Buffer;
        type: ContentType;
        delay: number;
      }[] = [];
      let size = 0;
      for (const message of input) {
        if (rows.length === 100)
          throw new RangeError("Queue sendBatch exceeds 100 messages");
        const type = message.contentType ?? "json";
        if (type === "v8")
          throw new TypeError(
            "Native queues accept JSON, text or bytes bodies",
          );
        const body = encode(message.body, type);
        size += body.length;
        if (size > 262144)
          throw new RangeError("Queue sendBatch exceeds 256 KiB");
        rows.push({
          id: randomUUID(),
          body,
          type,
          delay: queueDelaySeconds(message.delaySeconds, batchDelay),
        });
      }
      return transact(async (tx) => {
        const now = await clock(tx);
        for (const row of rows)
          await tx.run(
            "INSERT INTO jobs.messages(id,queue,original_queue,content_type,body,created_at_ms,available_at_ms) VALUES (?,?,?,?,?,?,?)",
            [
              row.id,
              queue,
              queue,
              row.type,
              row.body,
              now,
              now + row.delay * 1000,
            ],
          );
        return { metadata: { metrics: await metrics(tx, queue) } };
      });
    });
  async function exhausted(
    tx: PgTransaction,
    policy: Policy,
    row: Pick<StoredMessage, "id" | "attempts">,
    now: number,
  ) {
    if (policy.dead_letter_queue) {
      await tx.run(
        "UPDATE jobs.messages SET queue=?,original_attempts=attempts,attempts=0,delivery_id=NULL,available_at_ms=? WHERE id=?",
        [policy.dead_letter_queue, now, row.id],
      );
      return "deadLettered" as const;
    }
    await tx.run(
      "UPDATE jobs.messages SET state='parked',parked_at_ms=?,delivery_id=NULL WHERE id=?",
      [now, row.id],
    );
    return "parked" as const;
  }
  const cleanup = (tx: PgTransaction) =>
    tx.run(
      "DELETE FROM jobs.deliveries d WHERE NOT EXISTS (SELECT 1 FROM jobs.messages m WHERE m.delivery_id=d.id)",
    );
  async function claim(policy: Policy) {
    return transact(async (tx) => {
      const now = await clock(tx);
      const abandoned = await tx.query<Pick<StoredMessage, "id" | "attempts">>(
        "SELECT m.id,m.attempts FROM jobs.messages m JOIN jobs.deliveries d ON d.id=m.delivery_id WHERE m.queue=? AND d.expires_at_ms<=? AND m.attempts>? ORDER BY m.available_at_ms,m.id LIMIT ? FOR UPDATE OF m",
        [policy.name, now, policy.max_retries, policy.max_batch_size],
      );
      for (const row of abandoned) await exhausted(tx, policy, row, now);
      await cleanup(tx);
      const count = await tx.first<{ n: string }>(
        "SELECT count(*)::text AS n FROM jobs.deliveries WHERE queue=? AND expires_at_ms>?",
        [policy.name, now],
      );
      if (Number(count!.n) >= policy.max_concurrency)
        return { status: "capacity" as const };
      const rows = await tx.query<StoredMessage>(
        `SELECT m.id,m.body,m.content_type,m.created_at_ms,m.available_at_ms,m.attempts FROM jobs.messages m
         LEFT JOIN jobs.deliveries d ON d.id=m.delivery_id
         WHERE m.queue=? AND m.state='pending' AND m.available_at_ms<=? AND (d.id IS NULL OR d.expires_at_ms<=?)
         ORDER BY m.available_at_ms,m.created_at_ms,m.id LIMIT ? FOR UPDATE OF m SKIP LOCKED`,
        [policy.name, now, now, policy.max_batch_size],
      );
      if (!rows.length) return { status: "empty" as const };
      if (
        rows.length < policy.max_batch_size &&
        now - Number(rows[0]!.available_at_ms) < policy.max_batch_timeout * 1000
      )
        return { status: "waiting" as const };
      const id = randomUUID();
      await tx.run(
        "INSERT INTO jobs.deliveries(id,queue,expires_at_ms) VALUES (?,?,?)",
        [id, policy.name, now + limits.leaseMilliseconds],
      );
      await tx.run(
        "UPDATE jobs.messages SET delivery_id=?,attempts=attempts+1 WHERE id=ANY(?::uuid[])",
        [id, rows.map((row) => row.id)],
      );
      return {
        status: "claimed" as const,
        metrics: await metrics(tx, policy.name),
        id,
        rows: rows.map((row) => ({ ...row, attempts: row.attempts + 1 })),
      };
    });
  }
  async function settle(
    policy: Policy,
    id: string,
    rows: StoredMessage[],
    decisions: readonly QueueDecision[],
  ) {
    return transact(async (tx) => {
      const now = await clock(tx);
      const owned = await tx.first<{
        queue: string;
        expires_at_ms: string | number;
      }>(
        "SELECT queue,expires_at_ms FROM jobs.deliveries WHERE id=? FOR UPDATE",
        [id],
      );
      if (
        !owned ||
        owned.queue !== policy.name ||
        Number(owned.expires_at_ms) <= now
      )
        throw new Error("Native queue lease is no longer owned");
      const members = await tx.query<{ id: string }>(
        "SELECT id FROM jobs.messages WHERE delivery_id=? FOR UPDATE",
        [id],
      );
      if (
        members.length !== rows.length ||
        members.some((member) => !rows.some((row) => row.id === member.id))
      )
        throw new Error("Native queue lease membership differs");
      const result = emptyResult("delivered");
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const decision = decisions[i]!;
        if (decision.action === "ack") {
          await tx.run(
            "DELETE FROM jobs.messages WHERE id=? AND delivery_id=?",
            [row.id, id],
          );
          result.acknowledged += 1;
        } else if (row.attempts > policy.max_retries) {
          result[await exhausted(tx, policy, row, now)] += 1;
        } else {
          await tx.run(
            "UPDATE jobs.messages SET delivery_id=NULL,available_at_ms=? WHERE id=? AND delivery_id=?",
            [
              now + (decision.delaySeconds ?? policy.retry_delay) * 1000,
              row.id,
              id,
            ],
          );
          result.retried += 1;
        }
      }
      await tx.run("DELETE FROM jobs.deliveries WHERE id=?", [id]);
      return result;
    });
  }
  return {
    binding(queue: PgQueueName) {
      policyFor(queue);
      return {
        send: (body: unknown, options?: PgQueueSendOptions) =>
          enqueue(queue, [{ body, ...options }]),
        sendBatch: (
          messages: Iterable<PgQueueSendRequest>,
          options?: { delaySeconds?: number },
        ) => enqueue(queue, messages, options),
        metrics: () => admit(() => transact((tx) => metrics(tx, queue))),
      };
    },
    get state(): "ready" | "closing" | "closed" {
      return open ? "ready" : drained ? "closed" : "closing";
    },
    run(
      queue: PgQueueName,
      consume: (
        batch: MessageBatch<unknown>,
        signal: AbortSignal,
      ) => Promise<unknown>,
    ): Promise<PgQueueRunResult> {
      const policy = policyFor(queue);
      return admit(async () => {
        if ((running.get(queue) ?? 0) >= policy.max_concurrency)
          return emptyResult("capacity");
        running.set(queue, (running.get(queue) ?? 0) + 1);
        let consumerOwnsSlot = false;
        try {
          const batch = await claim(policy);
          if (batch.status !== "claimed") return emptyResult(batch.status);
          const delivery = queueDelivery(
            queue,
            batch.rows.map((row) => ({
              id: row.id,
              createdAtMs: Number(row.created_at_ms),
              attempts: row.attempts,
              body: decode(row),
            })),
            batch.metrics,
          );
          const controller = new AbortController();
          controllers.add(controller);
          if (drainReason) controller.abort(drainReason);
          const pending = Promise.resolve().then(() => {
            if (controller.signal.aborted) throw controller.signal.reason;
            return consume(delivery.batch, controller.signal);
          });
          consumerOwnsSlot = true;
          const finished = pending
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              controllers.delete(controller);
              consumers.delete(finished);
              running.set(queue, running.get(queue)! - 1);
            });
          consumers.add(finished);
          let frozen: readonly QueueDecision[] | undefined;
          let onAbort!: () => void;
          const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => {
              frozen ??= delivery.finish(true);
              reject(controller.signal.reason);
            };
            if (controller.signal.aborted) onAbort();
            else
              controller.signal.addEventListener("abort", onAbort, {
                once: true,
              });
          });
          const timer = setTimeout(
            () =>
              controller.abort(
                new Error("Native queue execution deadline exceeded"),
              ),
            limits.executionTimeoutMillis,
          );
          let failure: { error: unknown } | undefined;
          try {
            await Promise.race([pending, aborted]);
          } catch (error) {
            failure = { error };
          } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", onAbort);
          }
          // Freeze decisions at completion/abort. A late callback cannot undo
          // settled custody, and keeps its local slot until it actually exits.
          const result = await settle(
            policy,
            batch.id,
            batch.rows,
            frozen ?? delivery.finish(Boolean(failure)),
          );
          if (failure) throw failure.error;
          return result;
        } finally {
          if (!consumerOwnsSlot) running.set(queue, running.get(queue)! - 1);
        }
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      open = false;
      draining ??= (async () => {
        while (active.size || consumers.size)
          await Promise.allSettled([...active, ...consumers]);
        drained = true;
      })();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          drainReason = new Error(
            "Native queue drain deadline exceeded; unfinished operations remain",
          );
          for (const controller of controllers) controller.abort(drainReason);
          reject(drainReason);
        }, limits.drainTimeoutMillis);
      });
      closing = Promise.race([draining, deadline]).finally(() =>
        clearTimeout(timer),
      );
      void closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}

/** Bind the existing main/data process consumers to their declared queue families. */
export function createPgQueueDispatcher(
  transport: Pick<Awaited<ReturnType<typeof createPgQueueTransport>>, "run">,
  consumers: {
    api: {
      queue(
        batch: MessageBatch<unknown>,
        signal?: AbortSignal,
      ): Promise<unknown>;
    };
    data: {
      queue(
        batch: MessageBatch<unknown>,
        signal?: AbortSignal,
      ): Promise<unknown>;
    };
  },
) {
  return {
    run(queue: PgQueueName) {
      const consumer =
        queue === "sync-batches" || queue === "sync-batches-dlq"
          ? consumers.data
          : consumers.api;
      return transport.run(queue, (batch, signal) =>
        consumer.queue(batch, signal),
      );
    },
  };
}
