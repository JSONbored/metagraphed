import { Buffer } from "node:buffer";
import type { PgKvRuntime } from "./pg-kv.ts";
import type { PgTransaction } from "./pg-pool.ts";

export interface NativeRateLimitDefinition {
  binding: string;
  limit: number;
  period: 10 | 60;
}

function nonnegativeInteger(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^\d+$/.test(value))
  ) {
    throw new TypeError("Invalid native rate counter");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RangeError("Invalid native rate counter");
  return parsed;
}

/** Explicit, shared PostgreSQL limiters. A second bucket is retained in full
 * until its last event must be older than the configured window. This enforces
 * a conservative rolling window (up to one extra second), not Cloudflare's
 * distributed approximate algorithm. Failed admission spends nothing. */
export function createPgRateLimits(
  runtime: PgKvRuntime,
  definitions: readonly NativeRateLimitDefinition[],
  onError: (error: unknown, binding: string) => void,
) {
  if (definitions.length === 0)
    throw new TypeError("Native rate policies are required");
  if (typeof onError !== "function")
    throw new TypeError("Native rate error reporting is required");
  const bindings: Record<string, Pick<RateLimit, "limit">> = Object.create(
    null,
  );
  const policies: NativeRateLimitDefinition[] = [];
  const initializers = new Map<string, Promise<void>>();
  const requirePolicy = async (
    tx: PgTransaction,
    { binding, limit, period }: NativeRateLimitDefinition,
    initialize = false,
  ) => {
    type Policy = {
      request_limit: number | string;
      period_seconds: number | string;
    };
    const read = () =>
      tx.first<Policy>(
        "SELECT request_limit,period_seconds FROM auth.rate_limit_policies WHERE binding=?",
        [binding],
      );
    let stored = await read();
    if (!stored && initialize) {
      // Only first creation contends on this binding's unique key. Established
      // policies need no shared exclusive lock across unrelated caller keys.
      await tx.run(
        "INSERT INTO auth.rate_limit_policies(binding,request_limit,period_seconds) VALUES (?,?,?) ON CONFLICT(binding) DO NOTHING",
        [binding, limit, period],
      );
      stored = await read();
    }
    if (
      !stored ||
      nonnegativeInteger(stored.request_limit) !== limit ||
      nonnegativeInteger(stored.period_seconds) !== period
    )
      throw new Error(`Native rate policy differs: ${binding}`);
  };
  const initializePolicy = (policy: NativeRateLimitDefinition) => {
    let pending = initializers.get(policy.binding);
    if (!pending) {
      // Commit first-use policy custody before taking any caller-key lock.
      // Otherwise a blocked first caller could block every unrelated key.
      pending = runtime.transaction(
        async (tx) => {
          await tx.run("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
          await requirePolicy(tx, policy, true);
        },
        { isolation: "read committed" },
      );
      initializers.set(policy.binding, pending);
      void pending.catch(() => initializers.delete(policy.binding));
    }
    return pending;
  };
  for (const definition of definitions) {
    const { binding, limit, period } = definition;
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(binding) ||
      Object.hasOwn(bindings, binding) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 2147483647 ||
      (period !== 10 && period !== 60)
    ) {
      throw new TypeError("Invalid native rate policy");
    }
    const policy = { binding, limit, period };
    policies.push(policy);
    bindings[binding] = {
      async limit({ key }) {
        if (typeof key !== "string")
          throw new TypeError("Native rate key must be text");
        const encoded = Buffer.from(key, "utf8");
        if (
          encoded.length === 0 ||
          encoded.length > 1024 ||
          encoded.toString("utf8") !== key
        ) {
          throw new RangeError("Native rate key exceeds its UTF-8 budget");
        }
        return initializePolicy(policy)
          .then(() =>
            runtime.transaction(
              async (tx) => {
                await tx.run("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
                await requirePolicy(tx, policy);
                await tx.query<{ pg_advisory_xact_lock: null }>(
                  "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?,0))",
                  [`metagraphed:rate:${binding}:${encoded.toString("hex")}`],
                );
                const clock = await tx.first<{ second: string | number }>(
                  "SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS second",
                );
                const second = nonnegativeInteger(clock?.second);
                if (second > Number.MAX_SAFE_INTEGER - period - 1)
                  throw new RangeError("Native rate clock exceeds its range");
                await tx.run(
                  "DELETE FROM auth.rate_limit_buckets WHERE binding=? AND key=? AND bucket_second<?",
                  [binding, encoded, second - period],
                );
                const current = await tx.first<{ used: string | number }>(
                  "SELECT COALESCE(sum(requests),0)::bigint AS used FROM auth.rate_limit_buckets WHERE binding=? AND key=? AND bucket_second>=?",
                  [binding, encoded, second - period],
                );
                if (nonnegativeInteger(current?.used) >= limit)
                  return { success: false };
                await tx.run(
                  "INSERT INTO auth.rate_limit_buckets(binding,key,bucket_second,requests,expires_at) VALUES (?,?,?,1,?) " +
                    "ON CONFLICT(binding,key,bucket_second) DO UPDATE SET requests=auth.rate_limit_buckets.requests+1",
                  [binding, encoded, second, second + period + 1],
                );
                return { success: true };
              },
              { isolation: "read committed" },
            ),
          )
          .catch((error: unknown) => {
            // Native admission remains conservative even for legacy consumers
            // (including AI) that otherwise fail open on a thrown limiter error.
            try {
              onError(error, binding);
            } catch {
              /* Keep admission denied. */
            }
            return { success: false };
          });
      },
    };
  }
  return {
    bindings: Object.freeze(bindings),
    /** The process's existing housekeeping scheduler owns when this runs. */
    async pruneExpired(limit = 1000): Promise<number> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
        throw new RangeError("Invalid rate pruning budget");
      const ordered = [...policies].sort((a, b) =>
        a.binding < b.binding ? -1 : 1,
      );
      for (const policy of ordered) await initializePolicy(policy);
      return runtime.transaction(
        async (tx) => {
          await tx.run("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
          // Consistent order avoids cross-binding bootstrap cycles. Existing
          // policies are immutable reads, not a global admission lock.
          for (const policy of ordered) await requirePolicy(tx, policy);
          const result = await tx.run(
            "WITH expired AS (SELECT binding,key,bucket_second FROM auth.rate_limit_buckets " +
              "WHERE expires_at<=floor(extract(epoch FROM pg_catalog.clock_timestamp())) ORDER BY expires_at LIMIT ? FOR UPDATE SKIP LOCKED) " +
              "DELETE FROM auth.rate_limit_buckets AS target USING expired WHERE target.binding=expired.binding AND target.key=expired.key AND target.bucket_second=expired.bucket_second",
            [limit],
          );
          return result.changes;
        },
        { isolation: "read committed" },
      );
    },
  };
}
