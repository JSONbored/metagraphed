import { z } from "zod";
import { ANALYTICS_WINDOW_DAYS } from "../workers/config.ts";
import { formatRpcUsage } from "./health-serving.ts";
import { windowCutoffMs } from "./rpc-usage-cold-tier.ts";
import { rpcWeightedPercentile } from "./rpc-usage-native.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";

type Row = Record<string, unknown>;
const text = z.string();
const aggregate = `sum(sample_weight)::text AS requests,
  sum(CASE WHEN ok THEN sample_weight ELSE 0 END)::text AS ok_count,
  sum(latency_ms * sample_weight) / sum(sample_weight) AS avg_latency_ms`;
const where =
  "FROM app.rpc_usage_events WHERE pool='public' AND occurred_at > $1 AND occurred_at <= $2";
function finite(value: unknown): number {
  const number = Number(value);
  if (value === null || !Number.isFinite(number))
    throw new Error("Invalid native RPC aggregate");
  return number;
}
function count(value: unknown): number {
  const number = finite(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error("Native RPC count exceeds exact numeric range");
  return number;
}
function identity(value: unknown): string {
  return text.parse(JSON.parse(text.parse(value)));
}
function numeric(row: Row): Row {
  return {
    ...row,
    requests: count(row.requests),
    ok_count: count(row.ok_count),
    avg_latency_ms: finite(row.avg_latency_ms),
  };
}

/** All five rollups observe one snapshot; output remains the shared public contract. */
export function createPgRpcUsageReader(
  runtime: Pick<PgStoreRuntime, "transaction">,
) {
  return async (window: string, now: number): Promise<Row | null> => {
    const label = Object.hasOwn(ANALYTICS_WINDOW_DAYS, window) ? window : "7d";
    const bounds = windowCutoffMs(label, now);
    if (!bounds) return null;
    return runtime.transaction(
      async (scope) => {
        await scope.run("SET TRANSACTION READ ONLY");
        const params = [bounds.cutoff, now];
        const totals = await scope.first<Row>(
          `SELECT ${aggregate},
        sum(CASE WHEN attempts > 1 THEN sample_weight ELSE 0 END)::text AS failover,
        sum(CASE WHEN cache='hit' THEN sample_weight ELSE 0 END)::text AS hits,
        min(occurred_at)::text AS first, max(occurred_at)::text AS last ${where}`,
          params,
        );
        if (!totals || totals.requests === null) return null;
        const normalized = numeric(totals);
        const endpoints = await scope.query<Row>(
          `SELECT network_key,endpoint_key,provider_key,${aggregate}
        ${where} GROUP BY network_key,endpoint_key,provider_key
        ORDER BY sum(sample_weight) DESC,network_key COLLATE "C",endpoint_key COLLATE "C",provider_key COLLATE "C" LIMIT 100`,
          params,
        );
        const networks = await scope.query<Row>(
          `SELECT network_key,${aggregate} ${where}
        GROUP BY network_key ORDER BY sum(sample_weight) DESC,network_key COLLATE "C" LIMIT 100`,
          params,
        );
        const buckets = await scope.query<Row>(
          `SELECT (occurred_at / $3::bigint) * $3::bigint AS ts,${aggregate}
        ${where} GROUP BY ts ORDER BY ts LIMIT 1000`,
          [...params, bounds.bucketMs],
        );
        const latencies = await scope.query<{
          latency: unknown;
          weight: unknown;
        }>(
          `SELECT latency_ms AS latency,sum(sample_weight)::text AS weight ${where}
         GROUP BY latency_ms ORDER BY latency_ms LIMIT 100001`,
          params,
        );
        if (latencies.length > 100000)
          throw new Error("Native RPC latency histogram exceeds budget");
        const histogram = new Map(
          latencies.map((row) => [finite(row.latency), count(row.weight)]),
        );
        if (
          [...histogram.values()].reduce((a, b) => a + b, 0) !==
          normalized.requests
        )
          throw new Error("Native RPC latency census mismatch");
        const first = count(totals.first),
          last = count(totals.last);
        return formatRpcUsage({
          window: label,
          observedAt: last,
          bucketGranularity: bounds.granularity,
          totals: {
            total: normalized.requests,
            ok_count: normalized.ok_count,
            avg_latency_ms: normalized.avg_latency_ms,
            failover_count: count(totals.failover),
            cache_hits: count(totals.hits),
          },
          latency: {
            p50: rpcWeightedPercentile(histogram, 0.5),
            p95: rpcWeightedPercentile(histogram, 0.95),
          },
          coverage: {
            segments: [{ source: "postgresql", start: first, end: last }],
            latency: { start: first, end: last },
          },
          endpointRows: endpoints.map((row) => ({
            ...numeric(row),
            endpoint_id: identity(row.endpoint_key) || null,
            provider: identity(row.provider_key) || null,
          })),
          networkRows: networks.map((row) => ({
            ...numeric(row),
            network: identity(row.network_key),
          })),
          bucketRows: buckets.map((row) => {
            const values = numeric(row);
            return {
              ...values,
              ts: count(row.ts),
              errors: count(row.requests) - count(row.ok_count),
            };
          }),
        });
      },
      { isolation: "repeatable read" },
    );
  };
}
