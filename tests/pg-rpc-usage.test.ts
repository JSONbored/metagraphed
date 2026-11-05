import { expect, test, vi } from "vitest";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";
import type { RpcUsageEvent } from "../src/rpc-usage-capture.ts";
import { recordRpcUsageEvent } from "../src/rpc-usage-capture.ts";
import {
  createPgRpcUsageStore,
  type PgRpcUsageOptions,
} from "../src/pg-rpc-usage.ts";
import { createPgRpcUsageReader } from "../src/pg-rpc-usage-reader.ts";
import { loadRpcUsageHotTier } from "../src/rpc-usage-hot-tier.ts";
import { apiEnv } from "./helpers/worker-env.ts";

const stamp = 1_790_000_000_000;
const event: RpcUsageEvent = {
  pool: "public",
  network: "finney",
  endpointId: "node",
  provider: "provider",
  ok: true,
  status: 200,
  attempts: 1,
  latencyMs: 12.5,
  cache: "miss",
};
const options: PgRpcUsageOptions = {
  maxPending: 3,
  maxPendingBytes: 4096,
  batchSize: 2,
  retentionDays: 31,
  executionTimeoutMillis: 1000,
  drainTimeoutMillis: 1000,
  now: () => stamp,
};
function fixture(overrides: Partial<PgRpcUsageOptions> = {}) {
  const batches: unknown[][] = [];
  let fail = false;
  let wait: Promise<void> | undefined;
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(fn) {
      const result = await fn({
        async run(_text, values) {
          batches.push(values ?? []);
          if (wait) await wait;
          return { changes: 1 };
        },
        async query<Row>(sql: string) {
          return (
            sql.includes("rpc_usage_prune") ? [{ removed: 0 }] : []
          ) as Row[];
        },
        async first() {
          return null;
        },
      });
      if (fail) throw new Error("uncertain commit");
      return result;
    },
  };
  const selectedOptions = { ...options, ...overrides };
  const store = createPgRpcUsageStore(runtime, selectedOptions);
  return {
    store,
    batches,
    runtime,
    selectedOptions,
    fail(value: boolean) {
      fail = value;
    },
    wait(value: Promise<void>) {
      wait = value;
    },
  };
}

test("capture snapshots normalized events without awaiting a database and retains replay identity", async () => {
  const f = fixture();
  const input = {
    ...event,
    network: "a\0b\ud800",
    latencyMs: -1,
    attempts: NaN,
  };
  expect(f.store.record(input)).toBe(true);
  input.network = "changed";
  expect(f.batches).toHaveLength(0);
  f.fail(true);
  await expect(f.store.flush()).rejects.toThrow("uncertain commit");
  expect(f.store.stats()).toMatchObject({
    accepted: 1,
    persisted: 0,
    pending: 1,
    failures: 1,
  });
  f.fail(false);
  expect(await f.store.flush()).toBe(1);
  expect(f.batches[0]).toEqual(f.batches[1]);
  expect(f.batches[0].slice(1)).toEqual([
    String(stamp),
    "public",
    '"a\\u0000b\\ud800"',
    '"node"',
    '"provider"',
    "miss",
    true,
    0,
    0,
    200,
    "1",
  ]);
  expect(f.store.stats()).toMatchObject({
    persisted: 1,
    pending: 0,
    pendingBytes: 0,
  });
  expect(await f.store.flush()).toBe(0);
  await f.store.close();
});

test("finite admission, bounded batches and shutdown retain explicit loss counts", async () => {
  const f = fixture();
  expect([1, 2, 3, 4].map(() => f.store.record(event))).toEqual([
    true,
    true,
    true,
    false,
  ]);
  expect(await f.store.flush()).toBe(2);
  expect(f.batches[0]).toHaveLength(24);
  await f.store.close();
  expect(f.store.record(event)).toBe(false);
  expect(f.store.stats()).toMatchObject({
    accepted: 3,
    persisted: 3,
    rejected: 2,
    pending: 0,
  });
});

test("overlapping flushes share one commit and accept later events into a later batch", async () => {
  const f = fixture();
  let release!: () => void;
  f.wait(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.store.record(event);
  const first = f.store.flush();
  expect(f.store.flush()).toBe(first);
  f.store.record(event);
  release();
  expect(await first).toBe(1);
  expect(f.store.stats().pending).toBe(1);
  await f.store.close();
});

test("invalid options, clocks, identities, dimensions and byte budgets fail explicitly", async () => {
  for (const values of [
    { maxPending: 0 },
    { maxPendingBytes: 1 },
    { batchSize: 501 },
    { retentionDays: 30 },
    { executionTimeoutMillis: 0 },
    { drainTimeoutMillis: 0 },
  ])
    expect(() => fixture(values)).toThrow();
  for (const values of [{ now: () => NaN }, { id: () => "invalid" }]) {
    const f = fixture(values);
    expect(f.store.record(event)).toBe(false);
    await f.store.close();
  }
  const clock = fixture({ now: undefined });
  expect(clock.store.record(event)).toBe(true);
  await clock.store.close();
  const f = fixture({ maxPending: 10, maxPendingBytes: 1024 });
  expect(f.store.record({ ...event, provider: "x".repeat(20000) })).toBe(false);
  expect(f.store.record({ ...event, endpointId: "x".repeat(800) })).toBe(false);
  expect(
    f.store.record({ ...event, pool: "wrong" as RpcUsageEvent["pool"] }),
  ).toBe(false);
  expect(
    f.store.record({ ...event, cache: "wrong" as RpcUsageEvent["cache"] }),
  ).toBe(false);
  expect(f.store.record({ ...event, endpointId: 7 as unknown as string })).toBe(
    false,
  );
  expect(
    f.store.record({ ...event, network: "", provider: null, endpointId: null }),
  ).toBe(true);
  expect(f.store.record({ ...event, provider: "x".repeat(600) })).toBe(false);
  await f.store.close();
});

test("selected native capture and read paths never call Analytics Engine", async () => {
  const dataset = { writeDataPoint: vi.fn() };
  const record = vi.fn(() => false),
    load = vi.fn(async () => null);
  const native = { record, load };
  expect(recordRpcUsageEvent(dataset, event, native)).toBe(false);
  expect(dataset.writeDataPoint).not.toHaveBeenCalled();
  record.mockImplementation(() => {
    throw new Error("offline");
  });
  expect(recordRpcUsageEvent(dataset, event, native)).toBe(false);
  expect(dataset.writeDataPoint).not.toHaveBeenCalled();
  expect(await loadRpcUsageHotTier(apiEnv({ RPC_USAGE_STORE: native }))).toBe(
    null,
  );
  expect(load).toHaveBeenCalledWith("7d", expect.any(Number));
});

test("prune is bounded and uses the configured retention cutoff", async () => {
  const calls: unknown[][] = [];
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(fn) {
      return fn({
        async run() {
          return { changes: 0 };
        },
        async first() {
          return null;
        },
        async query<Row>(sql: string, values: unknown[]) {
          expect(sql).toBe(
            "SELECT app.rpc_usage_prune($1::bigint,10000) AS removed",
          );
          calls.push(values);
          return [{ removed: 1 }] as Row[];
        },
      });
    },
  };
  const store = createPgRpcUsageStore(runtime, options);
  expect(await store.prune()).toBe(1);
  expect(calls).toEqual([[String(stamp - 31 * 86400000)]]);
  await expect(store.prune(0)).rejects.toThrow("timestamp");
  await store.close();
});

function readerFixture() {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let totals: Record<string, unknown> | null = {
    requests: "4",
    ok_count: "3",
    avg_latency_ms: 20,
    failover: "1",
    hits: "1",
    first: String(stamp - 1000),
    last: String(stamp),
  };
  let latencies: { latency: unknown; weight: unknown }[] = [
    { latency: 10, weight: "2" },
    { latency: 30, weight: "2" },
  ];
  let endpoint = '"a\\u0000b\\ud800"';
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(fn, config) {
      expect(config?.isolation).toBe("repeatable read");
      return fn({
        async run(sql) {
          expect(sql).toBe("SET TRANSACTION READ ONLY");
          return { changes: 0 };
        },
        async first<Row>(sql: string, values?: unknown[]) {
          calls.push({ sql, values });
          return totals as Row | null;
        },
        async query<Row>(sql: string, values?: unknown[]) {
          calls.push({ sql, values });
          const rows = sql.includes("GROUP BY latency_ms")
            ? latencies
            : sql.includes("GROUP BY ts")
              ? [
                  {
                    requests: "4",
                    ok_count: "3",
                    avg_latency_ms: 20,
                    ts: stamp - (stamp % 3600000),
                  },
                ]
              : [
                  {
                    requests: "4",
                    ok_count: "3",
                    avg_latency_ms: 20,
                    network_key: '"finney"',
                    endpoint_key: endpoint,
                    provider_key: '""',
                  },
                ];
          return rows as Row[];
        },
      });
    },
  };
  return {
    load: createPgRpcUsageReader(runtime),
    calls,
    totals(value: typeof totals) {
      totals = value;
    },
    latencies(value: typeof latencies) {
      latencies = value;
    },
    endpoint(value: string) {
      endpoint = value;
    },
  };
}

test("reader keeps the common payload, weighted measurements, exact identities and public isolation", async () => {
  const f = readerFixture();
  const result = await f.load("unknown", stamp);
  expect(result).toMatchObject({
    window: "7d",
    observed_at: stamp,
    source: "rpc-proxy",
    coverage: {
      segments: [{ source: "postgresql", start: stamp - 1000, end: stamp }],
    },
    summary: {
      total_requests: 4,
      ok_requests: 3,
      error_requests: 1,
      failover_requests: 1,
      cache_hits: 1,
      latency_ms: { p50: 20, p95: 30, avg: 20 },
    },
    endpoints: [{ endpoint_id: "a\0b\ud800", provider: null, requests: 4 }],
    networks: [{ network: "finney", requests: 4 }],
    buckets: [{ requests: 4, errors: 1 }],
  });
  expect(f.calls).toHaveLength(5);
  expect(f.calls.every(({ sql }) => sql.includes("pool='public'"))).toBe(true);
  expect(f.calls[0].values).toEqual([stamp - 7 * 86400000, stamp]);
  expect(await f.load("7d", 0)).toBe(null);
});

test("reader declines empty windows and refuses corrupt or incomplete measurements", async () => {
  const f = readerFixture();
  f.totals(null);
  expect(await f.load("7d", stamp)).toBe(null);
  f.totals({ requests: null });
  expect(await f.load("7d", stamp)).toBe(null);
  f.totals({ requests: "9007199254740992" });
  await expect(f.load("7d", stamp)).rejects.toThrow("exact numeric");
  f.totals({ requests: "4", ok_count: "3", avg_latency_ms: Infinity });
  await expect(f.load("7d", stamp)).rejects.toThrow("aggregate");
  const valid = readerFixture();
  valid.latencies([{ latency: 10, weight: "3" }]);
  await expect(valid.load("7d", stamp)).rejects.toThrow("census");
  valid.latencies(
    Array.from({ length: 100001 }, () => ({ latency: 1, weight: "1" })),
  );
  await expect(valid.load("7d", stamp)).rejects.toThrow("budget");
  const invalidIdentity = readerFixture();
  invalidIdentity.endpoint("7");
  await expect(invalidIdentity.load("7d", stamp)).rejects.toThrow();
  const emptyIdentity = readerFixture();
  emptyIdentity.endpoint('""');
  expect((await emptyIdentity.load("7d", stamp))?.endpoints).toMatchObject([
    { endpoint_id: null },
  ]);
});

test("close rejects on failed commits, retains rows and can be retried after recovery", async () => {
  const f = fixture();
  f.store.record(event);
  f.fail(true);
  await expect(f.store.close()).rejects.toThrow("uncertain commit");
  expect(f.store.stats().pending).toBe(1);
  f.fail(false);
  await f.store.close();
  expect(f.store.stats().pending).toBe(0);
});

test("execution timeout retains its slot until a late commit, without duplicate flush or close spinning", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture({ executionTimeoutMillis: 10, drainTimeoutMillis: 50 });
    let release!: () => void;
    f.wait(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.store.record(event);
    const flushing = expect(f.store.flush()).rejects.toThrow(
      "execution deadline",
    );
    await vi.advanceTimersByTimeAsync(11);
    await flushing;
    expect(await f.store.flush()).toBe(0);
    await expect(f.store.close()).rejects.toThrow("remains in flight");
    expect(f.store.stats().pending).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.stats().pending).toBe(0);
    expect(f.batches).toHaveLength(1);
    await f.store.close();
  } finally {
    vi.useRealTimers();
  }
});

test("drain deadline is finite across batches and preserves the unfinished tail", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture({
      batchSize: 1,
      executionTimeoutMillis: 50,
      drainTimeoutMillis: 10,
    });
    f.selectedOptions.drainTimeoutMillis = 1000000;
    let release!: () => void;
    f.wait(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    f.store.record(event);
    f.store.record(event);
    const close = f.store.close();
    expect(f.store.close()).toBe(close);
    const failed = expect(close).rejects.toThrow("drain deadline");
    await vi.advanceTimersByTimeAsync(11);
    await failed;
    expect(f.store.stats().pending).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.stats().pending).toBe(1);
    await f.store.close();
    expect(f.store.stats().pending).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("concurrent prune calls are bounded by one database task", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture();
  const original = f.runtime.transaction;
  f.runtime.transaction = async (fn, config) => {
    await waiting;
    return original(fn, config);
  };
  const first = f.store.prune();
  expect(await f.store.prune()).toBe(0);
  release();
  await first;
  await f.store.close();
});

test("prune refuses missing, malformed and out-of-budget deletion receipts", async () => {
  for (const result of [
    [],
    [{ removed: -1 }],
    [{ removed: 10001 }],
    [{ removed: NaN }],
    [{ removed: 1.5 }],
    [{ removed: 1 }, { removed: 2 }],
  ]) {
    const f = fixture();
    f.runtime.transaction = async (fn) =>
      fn({
        async run() {
          return { changes: 0 };
        },
        async first() {
          return null;
        },
        async query<Row>() {
          return result as Row[];
        },
      });
    await expect(f.store.prune()).rejects.toThrow("retention receipt");
    await f.store.close();
  }
  const f = fixture();
  expect(await f.store.prune()).toBe(0);
  await f.store.close();
});
