import { randomUUID } from "node:crypto";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { RpcUsageEvent } from "./rpc-usage-capture.ts";
import { usageDataPoint } from "./rpc-usage-capture.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import { createPgRpcUsageReader } from "./pg-rpc-usage-reader.ts";

export interface PgRpcUsageOptions {
  maxPending: number;
  maxPendingBytes: number;
  batchSize: number;
  retentionDays: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
  now?: () => number;
  id?: () => string;
}
type Pending = { values: unknown[]; bytes: number };
const day = 86400000;
function bounded(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`Invalid native RPC ${name}`);
}

/** A finite in-memory handoff. Accepted rows become durable only after flush. */
export function createPgRpcUsageStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
  options: PgRpcUsageOptions,
) {
  bounded(options.maxPending, 1, 100000, "pending count");
  bounded(options.maxPendingBytes, 1024, 64 * 1024 * 1024, "pending bytes");
  bounded(options.batchSize, 1, 500, "batch size");
  bounded(options.retentionDays, 31, 93, "retention");
  const maxPending = options.maxPending,
    maxBytes = options.maxPendingBytes;
  const batchSize = options.batchSize,
    retention = options.retentionDays * day;
  const drainTimeout = options.drainTimeoutMillis;
  const now = options.now ?? Date.now,
    id = options.id ?? randomUUID;
  const work = createNativeWorkGroup({ name: "Native RPC usage", ...options });
  const pending: Pending[] = [];
  let bytes = 0,
    open = true,
    accepted = 0,
    persisted = 0,
    rejected = 0,
    failures = 0;
  let flushing: Promise<number> | undefined;
  let closing: Promise<void> | undefined;
  const stats = () => ({
    accepted,
    persisted,
    rejected,
    failures,
    pending: pending.length,
    pendingBytes: bytes,
  });
  const flush = (): Promise<number> => {
    if (flushing) return flushing;
    if (!pending.length) return Promise.resolve(0);
    const batch = pending.slice(0, batchSize);
    flushing = work
      .run(
        "flush",
        1,
        () => 0,
        (scope) =>
          scope.invoke(async () => {
            const values = batch.flatMap((entry) => entry.values);
            const tuples = batch.map(
              (_, i) =>
                `(${Array.from({ length: 12 }, (_, j) => `$${i * 12 + j + 1}`).join(",")})`,
            );
            await runtime.transaction(async (transaction) => {
              await transaction.run(
                `INSERT INTO app.rpc_usage_events
          (event_id,occurred_at,pool,network_key,endpoint_key,provider_key,cache,ok,attempts,latency_ms,status,sample_weight)
          SELECT event_id::uuid,occurred_at::bigint,pool,network_key,endpoint_key,provider_key,cache,ok::boolean,attempts::float8,latency_ms::float8,status::float8,sample_weight::bigint
          FROM (VALUES ${tuples.join(",")}) AS incoming(event_id,occurred_at,pool,network_key,endpoint_key,provider_key,cache,ok,attempts,latency_ms,status,sample_weight)
          ON CONFLICT (event_id) DO NOTHING`,
                values,
              );
            });
            pending.splice(0, batch.length);
            bytes -= batch.reduce((sum, entry) => sum + entry.bytes, 0);
            persisted += batch.length;
            return batch.length;
          }),
      )
      .catch((error) => {
        failures++;
        throw error;
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  };
  return {
    load: createPgRpcUsageReader(runtime),
    stats,
    record(event: RpcUsageEvent): boolean {
      try {
        if (!open || pending.length >= maxPending)
          throw new Error("RPC admission closed");
        if (
          !["public", "fullnode"].includes(event.pool) ||
          !["hit", "miss", "bypass"].includes(event.cache)
        )
          throw new Error("Invalid RPC dimensions");
        const stamp = now();
        bounded(stamp, 0, Number.MAX_SAFE_INTEGER, "timestamp");
        const point = usageDataPoint(event);
        const keys = point.blobs.slice(1, 4).map((value) => {
          if (typeof value !== "string")
            throw new TypeError("Invalid RPC identity");
          return JSON.stringify(value);
        });
        const size = new TextEncoder().encode(keys.join("")).length + 256;
        if (size > 16384 || bytes + size > maxBytes)
          throw new Error("RPC byte budget exceeded");
        const eventId = id();
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            eventId,
          )
        )
          throw new Error("Invalid native RPC id");
        pending.push({
          bytes: size,
          values: [
            eventId,
            String(stamp),
            event.pool,
            ...keys,
            event.cache,
            point.doubles[0] === 1,
            point.doubles[1],
            point.doubles[2],
            point.doubles[3],
            "1",
          ],
        });
        bytes += size;
        accepted++;
        return true;
      } catch {
        rejected++;
        return false;
      }
    },
    flush,
    async prune(stamp = now()): Promise<number> {
      bounded(stamp, retention, Number.MAX_SAFE_INTEGER, "retention timestamp");
      return work.run(
        "prune",
        1,
        () => 0,
        (scope) =>
          scope.invoke(() =>
            runtime.transaction(async (transaction) => {
              const rows = await transaction.query<{ event_id: string }>(
                `DELETE FROM app.rpc_usage_events
          WHERE event_id IN (SELECT event_id FROM app.rpc_usage_events WHERE occurred_at < $1
          ORDER BY occurred_at,event_id LIMIT 10000) RETURNING event_id`,
                [String(stamp - retention)],
              );
              return rows.length;
            }),
          ),
      );
    },
    close(): Promise<void> {
      open = false;
      if (closing) return closing;
      let expired = false;
      let timer: ReturnType<typeof setTimeout>;
      const drain = (async () => {
        while (pending.length) {
          if (expired) throw new Error("Native RPC drain deadline exceeded");
          if ((await flush()) === 0 && pending.length)
            throw new Error("Native RPC flush remains in flight");
        }
        await work.close();
      })();
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(
            new Error(
              "Native RPC drain deadline exceeded; pending rows retained",
            ),
          );
        }, drainTimeout);
      });
      closing = Promise.race([drain, deadline]).finally(() =>
        clearTimeout(timer),
      );
      void drain
        .catch(() => {})
        .finally(() => {
          if (expired) closing = undefined;
        });
      void closing.catch(() => {
        if (!expired) closing = undefined;
      });
      return closing;
    },
  };
}
