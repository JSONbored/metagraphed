import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronMetricStore } from "../src/pg-neuron-metrics.ts";
import { selectedNeuronMetricStore } from "../src/neuron-metric-store.ts";
import {
  readNeuronDailyMetricRows,
  readNeuronPerformanceRows,
} from "../src/neuron-snapshot-read.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const source = new DatabaseSync(":memory:");
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const payload = source
  .prepare("SELECT jsonb(?) AS payload")
  .get(
    '{"2":{"incentive":0.2,"incentive":0.3,"active":true,"axon":"a\\u0000b"},"02":{"incentive":99},"2":{"incentive":0.9,"active":false}}',
  )!.payload as Uint8Array;

afterAll(() => {
  decoder.close();
  source.close();
});

function fixture() {
  const calls: { text: string; values: unknown[] }[] = [];
  let failure = false;
  let rows: Record<string, unknown>[] = [
    {
      kind: 0,
      netuid: "7",
      shard: "0",
      snapshot_date: "",
      uid: null,
      hotkey: null,
      coldkey: null,
      payload,
    },
    {
      kind: 1,
      netuid: "7",
      shard: "0",
      snapshot_date: "",
      uid: "2",
      hotkey: "member",
      coldkey: null,
      payload: null,
    },
    {
      kind: 1,
      netuid: "7",
      shard: "0",
      snapshot_date: "",
      uid: "3",
      hotkey: "missing",
      coldkey: null,
      payload: null,
    },
  ];
  const read: ReadStoreDb = {
    async query<Row>(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (failure) throw new Error("selected store failed");
      return rows as Row[];
    },
    async first() {
      throw new Error("Unexpected first read");
    },
  };
  return {
    store: createPgNeuronMetricStore({ read }, decoder),
    calls,
    rows(value: typeof rows) {
      rows = value;
    },
    fail() {
      failure = true;
    },
  };
}

test("metric projection retains entry multiplicity, first property keys and text bytes", () => {
  const rows = decoder.metricEntries(payload, ["incentive", "active", "axon"]);
  expect(rows.map((row) => row.key)).toEqual(["2", "02", "2"]);
  expect(rows[0]?.values).toEqual({ incentive: 0.2, active: 1n, axon: "a\0b" });
  expect(decoder.metricEntries(payload, []).map((row) => row.values)).toEqual([
    {},
    {},
    {},
  ]);
  const array = source.prepare("SELECT jsonb('[{},{}]') AS payload").get()!
    .payload as Uint8Array;
  expect(decoder.metricEntries(array, [])).toEqual([]);
  for (const names of [
    ["bad.name"],
    ["active", "active"],
    Array(33).fill("active"),
  ])
    expect(() => decoder.metricEntries(payload, names)).toThrow("projection");
});

test("native performance rows preserve exact keys, duplicates and missing metrics", async () => {
  const f = fixture();
  const rows = await f.store.performanceRows();
  expect(rows.map((row) => [row.netuid, row.incentive, row.active])).toEqual([
    [7, 0.2, 1],
    [7, 0.9, 0],
    [7, null, null],
  ]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.text).toContain("UNION ALL");
  f.rows([]);
  expect(await f.store.performanceRows()).toEqual([]);
});

test("native daily projection binds its bound and preserves identity-only duplicates", async () => {
  const f = fixture();
  const rows = await f.store.dailyRows(
    7,
    "2026-01-01",
    ["uid", "hotkey", "incentive", "axon"],
    2,
  );
  expect(rows).toEqual([
    { uid: 2, hotkey: "member", incentive: 0.2, axon: "a\0b" },
    { uid: 2, hotkey: "member", incentive: 0.9, axon: null },
    { uid: 3, hotkey: "missing", incentive: null, axon: null },
  ]);
  expect(f.calls[0]?.values).toEqual(["7", "2026-01-01", 2]);
  expect(f.calls[0]?.text).toContain("LIMIT $3");
  expect(await f.store.dailyRows(7, null, ["uid"], 1)).toEqual([
    { uid: 2 },
    { uid: 2 },
    { uid: 3 },
  ]);
  expect(await f.store.dailyRows(2 ** 63, null, ["uid"], 1)).toEqual([]);
  for (const netuid of [NaN, 1.5])
    await expect(f.store.dailyRows(netuid, null, ["uid"], 1)).rejects.toThrow(
      "identity",
    );
  for (const columns of [[], ["unknown"], ["uid", "uid"]])
    await expect(f.store.dailyRows(7, null, columns, 1)).rejects.toThrow(
      "projection",
    );
  await expect(f.store.dailyRows(7, null, ["uid"], 0)).rejects.toThrow(
    "projection",
  );
});

test("shared metric readers select the native capability and never revive a failed source", async () => {
  const f = fixture();
  const unavailable: ReadStoreDb = {
    async query() {
      throw new Error("Legacy query must not run");
    },
    async first() {
      throw new Error("Legacy query must not run");
    },
  };
  const env = { NEURON_METRIC_STORE: f.store };
  expect(selectedNeuronMetricStore(env)).toBe(f.store);
  expect(await readNeuronPerformanceRows(unavailable, env)).toHaveLength(3);
  expect(
    await readNeuronDailyMetricRows(unavailable, env, 7, null, "uid", 2),
  ).toHaveLength(3);
  f.fail();
  await expect(readNeuronPerformanceRows(unavailable, env)).rejects.toThrow(
    "selected store failed",
  );
  await expect(
    readNeuronDailyMetricRows(unavailable, env, 7, null, "uid", 2),
  ).rejects.toThrow("selected store failed");
  for (const value of [
    undefined,
    null,
    {},
    { performanceRows() {} },
    { performanceRows: 1, dailyRows() {} },
  ])
    expect(() =>
      selectedNeuronMetricStore({ NEURON_METRIC_STORE: value }),
    ).toThrow("Invalid");
  for (const value of [null, undefined, 1, {}])
    expect(selectedNeuronMetricStore(value)).toBeNull();
});

test("actual performance routes select native metrics and keep error responses opaque", async () => {
  const f = fixture();
  const env = { ...dataApiEnv(), NEURON_METRIC_STORE: f.store };
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  for (const route of [
    "chain/performance",
    "subnets/7/performance/history?window=all",
  ]) {
    const request = new Request(`https://example.com/api/v1/${route}`);
    expect((await worker.fetch(request.clone(), env, ctx)).status).toBe(200);
    expect(
      (await worker.fetch(request.clone(), dataApiEnv(), ctx)).status,
    ).toBe(503);
  }
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/v1/subnets/7/neurons"),
        env,
        ctx,
      )
    ).status,
  ).toBe(503);
  f.fail();
  for (const route of [
    "chain/performance",
    "subnets/7/performance/history?window=all",
  ]) {
    const result = await worker.fetch(
      new Request(`https://example.com/api/v1/${route}`),
      env,
      ctx,
    );
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "data query failed" });
  }
});

test("member projection orders independent source parts and refuses incomplete document input", async () => {
  const f = fixture();
  const document = {
    kind: 0,
    netuid: "7",
    shard: "0",
    snapshot_date: "",
    uid: null,
    hotkey: null,
    coldkey: null,
    payload,
  };
  const member = {
    ...document,
    kind: 1,
    payload: null,
    uid: "2",
    hotkey: "member",
    coldkey: "cold",
  };
  f.rows([
    document,
    { ...document, netuid: "9" },
    { ...document, netuid: "6" },
    { ...member, netuid: "9" },
    { ...member, netuid: "6" },
    member,
  ]);
  expect((await f.store.performanceRows()).map((row) => row.netuid)).toEqual([
    6, 6, 7, 7, 9, 9,
  ]);
  f.rows([
    { ...document, snapshot_date: "2026-01-01" },
    { ...document, snapshot_date: "2026-01-02" },
    { ...member, uid: "3", snapshot_date: "2026-01-01" },
    { ...member, snapshot_date: "2026-01-02" },
    { ...member, snapshot_date: "2026-01-01" },
    { ...member, snapshot_date: "2026-01-01" },
  ]);
  expect(
    await f.store.dailyRows(7, null, ["snapshot_date", "uid", "coldkey"], 5),
  ).toEqual([
    { snapshot_date: "2026-01-02", uid: 2, coldkey: "cold" },
    { snapshot_date: "2026-01-02", uid: 2, coldkey: "cold" },
    { snapshot_date: "2026-01-01", uid: 2, coldkey: "cold" },
    { snapshot_date: "2026-01-01", uid: 2, coldkey: "cold" },
    { snapshot_date: "2026-01-01", uid: 2, coldkey: "cold" },
    { snapshot_date: "2026-01-01", uid: 2, coldkey: "cold" },
    { snapshot_date: "2026-01-01", uid: 3, coldkey: "cold" },
  ]);
  f.rows([document]);
  expect(await f.store.performanceRows()).toEqual([]);
  f.rows([{ ...document, payload: null }]);
  await expect(f.store.performanceRows()).rejects.toThrow(
    "Missing native metric document",
  );
  f.rows([member]);
  await expect(f.store.performanceRows()).rejects.toThrow(
    "Missing native member document",
  );
});
