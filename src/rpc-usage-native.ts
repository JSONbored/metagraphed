import { formatRpcUsage } from "./health-serving.ts";
import {
  readNativeRpcRows,
  type NativeRpcRow,
} from "./rpc-usage-native-store.ts";

type Group = {
  requests: number;
  ok_count: number;
  sum: number;
  measured: number;
  row: Record<string, unknown>;
};
const group = (row: Record<string, unknown> = {}): Group => ({
  requests: 0,
  ok_count: 0,
  sum: 0,
  measured: 0,
  row,
});
function add(target: Group, row: NativeRpcRow) {
  const weight = row[8] ?? 1;
  target.requests += weight;
  if (row[4] === true) target.ok_count += weight;
  if (row[6] !== null) {
    target.sum += row[6] * weight;
    target.measured += weight;
  }
  if (![target.requests, target.sum].every(Number.isSafeInteger))
    throw new Error("RPC aggregate exceeds numeric range");
}
function average(target: Group) {
  return target.measured ? target.sum / target.measured : null;
}
function breakdown(target: Group) {
  return {
    ...target.row,
    requests: target.requests,
    ok_count: target.ok_count,
    avg_latency_ms: average(target),
  };
}
function accumulate(
  map: Map<string, Group>,
  key: string,
  identity: Record<string, unknown>,
  row: NativeRpcRow,
) {
  let target = map.get(key);
  if (!target) {
    target = group(identity);
    map.set(key, target);
  }
  if (map.size > 65_536) throw new Error("RPC group budget exceeded");
  add(target, row);
}

/** Exact continuous percentile of the retained weighted observations. */
export function rpcWeightedPercentile(
  histogram: Map<number, number>,
  quantile: number,
): number | null {
  const entries = [...histogram].sort((a, b) => a[0] - b[0]);
  const count = entries.reduce((n, entry) => n + entry[1], 0);
  if (!count) return null;
  const position = (count - 1) * quantile,
    lower = Math.floor(position),
    upper = Math.ceil(position);
  let cumulative = 0,
    a = 0;
  for (const [value, weight] of entries) {
    const next = cumulative + weight;
    if (cumulative <= lower && lower < next) a = value;
    if (upper < next) return a + (value - a) * (position - lower);
    cumulative = next;
  }
  throw new Error("RPC percentile census is inconsistent");
}

export async function loadRpcUsageNative(
  env: unknown,
  {
    window,
    cutoff,
    bucketMs,
    granularity,
    until,
    now,
  }: {
    window: string;
    cutoff: number;
    bucketMs: number;
    granularity: string;
    until: number | null;
    now: number;
  },
): Promise<Record<string, unknown> | null | undefined> {
  const totals = group(),
    endpoints = new Map<string, Group>(),
    networks = new Map<string, Group>(),
    buckets = new Map<string, Group>();
  const histogram = new Map<number, number>();
  let failover = 0,
    cacheHits = 0,
    first = Infinity,
    last = -Infinity;
  const selected = await readNativeRpcRows(env, cutoff, until, now, (row) => {
    const weight = row[8] ?? 1;
    add(totals, row);
    if (row[5] !== null && row[5] > 1) failover += weight;
    if (row[7] === "hit") cacheHits += weight;
    first = Math.min(first, row[0]);
    last = Math.max(last, row[0]);
    if (row[6] !== null)
      histogram.set(row[6], (histogram.get(row[6]) ?? 0) + weight);
    if (histogram.size > 100_000)
      throw new Error("RPC latency histogram exceeds budget");
    accumulate(
      endpoints,
      JSON.stringify([row[2], row[3], row[1]]),
      { endpoint_id: row[2], provider: row[3], network: row[1] },
      row,
    );
    accumulate(networks, JSON.stringify(row[1]), { network: row[1] }, row);
    const ts = row[0] - (row[0] % bucketMs);
    accumulate(buckets, String(ts), { ts }, row);
  });
  if (selected === undefined) return undefined;
  if (!selected || !totals.requests) return null;
  const ranked = (values: Map<string, Group>) =>
    [...values.values()]
      .sort(
        (a, b) =>
          b.requests - a.requests ||
          JSON.stringify(a.row).localeCompare(JSON.stringify(b.row)),
      )
      .slice(0, 100)
      .map(breakdown);
  return formatRpcUsage({
    window,
    observedAt: last,
    bucketGranularity: granularity,
    totals: {
      total: totals.requests,
      ok_count: totals.ok_count,
      failover_count: failover,
      cache_hits: cacheHits,
      avg_latency_ms: average(totals),
    },
    latency: {
      p50: rpcWeightedPercentile(histogram, 0.5),
      p95: rpcWeightedPercentile(histogram, 0.95),
    },
    coverage: {
      segments: [{ source: "lakehouse", start: first, end: last }],
      latency: { start: first, end: last },
    },
    endpointRows: ranked(endpoints),
    networkRows: ranked(networks),
    bucketRows: [...buckets.values()]
      .sort((a, b) => Number(a.row.ts) - Number(b.row.ts))
      .slice(0, 1000)
      .map((b) => ({ ...breakdown(b), errors: b.requests - b.ok_count })),
  });
}
