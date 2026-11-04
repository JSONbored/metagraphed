import { afterAll, expect, test, vi } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronDailyViewStore } from "../src/pg-neuron-daily-view.ts";
import {
  selectedNeuronDailyViewStore,
  type NeuronDailyViewQuery,
} from "../src/neuron-daily-view-store.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
afterAll(() => decoder.close());
function fixture(codec = decoder) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  let bounds: (string | null)[] = ["2026-11-01", "2026-10-31"];
  const parts = [
    {
      kind: 0,
      netuid: "7",
      snapshot_date: "2026-11-01",
      shard: "0",
      uid: null,
      hotkey: null,
      coldkey: null,
      payload: decoder.encode(
        '{"1":{"stake_tao":5},"1":{"stake_tao":99},"2":"not-json","3":{"stake_tao":9007199254740993}}',
      ) as Uint8Array | null,
    },
    ...["3", "1", "2", "4"].map((uid) => ({
      kind: 1,
      netuid: "7",
      snapshot_date: "2026-11-01",
      shard: "0",
      uid,
      hotkey: `key-${uid}`,
      coldkey: null,
      payload: null,
    })),
    {
      kind: 0,
      netuid: "8",
      snapshot_date: "2026-10-31",
      shard: "1",
      uid: null,
      hotkey: null,
      coldkey: null,
      payload: decoder.encode('{"1":{"stake_tao":2}}') as Uint8Array | null,
    },
    {
      kind: 1,
      netuid: "8",
      snapshot_date: "2026-10-31",
      shard: "1",
      uid: "1",
      hotkey: "old",
      coldkey: "cold",
      payload: null,
    },
  ];
  const read: ReadStoreDb = {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      if (text.startsWith("SELECT MAX") || text.startsWith("SELECT MIN")) {
        const value = bounds.shift();
        return (value === undefined ? [] : [{ value }]) as Row[];
      }
      return parts as Row[];
    },
    async first() {
      throw new Error("unexpected first");
    },
  };
  return {
    store: createPgNeuronDailyViewStore({ read }, codec),
    calls,
    parts,
    setBounds(values: (string | null)[]) {
      bounds = values;
    },
  };
}

test("canonical daily member values preserve first keys, nulls, metadata and ordering", async () => {
  const f = fixture();
  expect(
    await f.store.rows({
      columns: [
        "snapshot_date",
        "netuid",
        "uid",
        "hotkey",
        "coldkey",
        "stake_tao",
      ],
      limit: 10,
    }),
  ).toEqual([
    {
      snapshot_date: "2026-11-01",
      netuid: 7,
      uid: 1,
      hotkey: "key-1",
      coldkey: null,
      stake_tao: 5,
    },
    {
      snapshot_date: "2026-11-01",
      netuid: 7,
      uid: 2,
      hotkey: "key-2",
      coldkey: null,
      stake_tao: null,
    },
    {
      snapshot_date: "2026-11-01",
      netuid: 7,
      uid: 3,
      hotkey: "key-3",
      coldkey: null,
      stake_tao: 9007199254740992,
    },
    {
      snapshot_date: "2026-11-01",
      netuid: 7,
      uid: 4,
      hotkey: "key-4",
      coldkey: null,
      stake_tao: null,
    },
    {
      snapshot_date: "2026-10-31",
      netuid: 8,
      uid: 1,
      hotkey: "old",
      coldkey: "cold",
      stake_tao: 2,
    },
  ]);
  const ascending = await f.store.rows({
    columns: ["uid", "snapshot_date"],
    netuid: 7,
    fromDay: "2026-10-01",
    beforeDay: "2026-11-02",
    days: ["2026-10-31", "2026-11-01"],
    oldestFirst: true,
    limit: 10,
  });
  expect(ascending[0]).toEqual({ uid: 1, snapshot_date: "2026-10-31" });
  expect(f.calls[1].values).toEqual([
    "7",
    "2026-10-01",
    "2026-11-02",
    "2026-10-31",
    "2026-11-01",
    10,
  ]);
  expect(f.calls[1].text).toContain(
    "ORDER BY m.snapshot_date ASC,m.netuid,m.uid",
  );
});

test("data-anchored windows keep exact source min/max and invalid-date behavior", async () => {
  const f = fixture();
  expect(await f.store.window(7)).toEqual({
    startDate: "2026-10-31",
    endDate: "2026-11-01",
  });
  expect(f.calls[1].values).toEqual(["2026-10-25"]);
  expect(f.calls[0].text).toContain(
    "EXISTS(SELECT 1 FROM app.neuron_daily_members",
  );
  f.setBounds(["invalid-day", "earlier-invalid"]);
  expect(await f.store.window(7, 7)).toEqual({
    startDate: "earlier-invalid",
    endDate: "invalid-day",
  });
  expect(f.calls.at(-1)?.values).toEqual(["7"]);
  f.setBounds(["2026-11-01", "2020-01-01"]);
  expect(await f.store.window(null, 7)).toEqual({
    startDate: "2020-01-01",
    endDate: "2026-11-01",
  });
  f.setBounds([null]);
  expect(await f.store.window(7)).toEqual({ startDate: null, endDate: null });
  f.setBounds([]);
  expect(await f.store.window(7)).toEqual({ startDate: null, endDate: null });
  f.setBounds(["2026-11-01"]);
  expect(await f.store.window(7)).toEqual({
    startDate: null,
    endDate: "2026-11-01",
  });
  expect(await f.store.window(7, 1e30)).toEqual({
    startDate: null,
    endDate: null,
  });
  for (const value of [-1, 36501, 1.5])
    await expect(f.store.window(value)).rejects.toThrow("Invalid");
});

test("daily view query contract rejects unsupported projections and fails closed on missing custody", async () => {
  const f = fixture();
  for (const query of [
    { columns: [], limit: 1 },
    { columns: ["uid", "uid"], limit: 1 },
    { columns: ["injected"], limit: 1 },
    { columns: ["uid"], limit: 0 },
    { columns: ["uid"], limit: 1000001 },
    { columns: ["uid"], limit: 1.5 },
    { columns: ["uid"], limit: 1, netuid: 1.5 },
    { columns: ["uid"], limit: 1, netuid: Infinity },
    { columns: ["uid"], limit: 1, oldestFirst: 1 },
    { columns: ["uid"], limit: 1, fromDay: 1 },
    { columns: ["uid"], limit: 1, beforeDay: 1 },
    { columns: ["uid"], limit: 1, days: "date" },
    { columns: ["uid"], limit: 1, days: [1] },
    { columns: ["uid"], limit: 1, days: Array(17).fill("day") },
  ])
    await expect(f.store.rows(query as NeuronDailyViewQuery)).rejects.toThrow(
      "Invalid",
    );
  expect(
    await f.store.rows({ columns: ["uid"], limit: 1, netuid: -1e30 }),
  ).toEqual([]);
  expect(await f.store.rows({ columns: ["uid"], limit: 1, days: [] })).toEqual(
    [],
  );
  f.parts[0].payload = null;
  await expect(f.store.rows({ columns: ["uid"], limit: 1 })).rejects.toThrow(
    "Missing canonical daily document",
  );
  for (const env of [null, undefined, {}, 1])
    expect(selectedNeuronDailyViewStore(env)).toBeNull();
  for (const value of [null, {}, { rows() {} }, { window() {} }])
    expect(() =>
      selectedNeuronDailyViewStore({ NEURON_DAILY_VIEW_STORE: value }),
    ).toThrow("Invalid");
  expect(
    selectedNeuronDailyViewStore({ NEURON_DAILY_VIEW_STORE: f.store }),
  ).toBe(f.store);
  expect(() =>
    selectedNeuronDailyViewStore({
      NEURON_DAILY_VIEW_STORE: { rows() {}, window: 1 },
    }),
  ).toThrow("Invalid");
});

test("daily rows retain network ties and reject missing or invalid projections", async () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    f.parts[5].snapshot_date = "2026-11-01";
    f.parts[6].snapshot_date = "2026-11-01";
    f.parts.push({ ...f.parts[1] });
    if (reverse) f.parts.reverse();
    const rows = await f.store.rows({ columns: ["netuid", "uid"], limit: 10 });
    expect(rows.at(-1)).toEqual({ netuid: 8, uid: 1 });
  }
  const orphan = fixture();
  orphan.parts.splice(1, 4);
  expect(await orphan.store.rows({ columns: ["uid"], limit: 10 })).toEqual([
    { uid: 1 },
  ]);
  const missing = fixture();
  missing.parts.splice(0, 1);
  await expect(
    missing.store.rows({ columns: ["uid"], limit: 10 }),
  ).rejects.toThrow("member projection");
  const empty = fixture({ ...decoder, memberMetrics: () => [] });
  await expect(
    empty.store.rows({ columns: ["uid"], limit: 10 }),
  ).rejects.toThrow("member projection");
  const blob = fixture({
    ...decoder,
    memberMetrics: (_payload, _names, keys) =>
      keys.map((key) => ({ key, values: { stake_tao: new Uint8Array([1]) } })),
  });
  await expect(
    blob.store.rows({ columns: ["stake_tao"], limit: 10 }),
  ).rejects.toThrow("BLOB");
});

test("daily routes select each capability and retain empty, invalid-window and failure responses", async () => {
  let failed = false,
    overflow = false;
  let dates: { startDate: string | null; endDate: string | null } = {
    startDate: "2026-10-31",
    endDate: "2026-11-01",
  };
  const rows = async () => {
    if (failed) throw new Error("private native failure");
    const result: Record<string, unknown>[] = [];
    if (overflow) result.length = 1000000;
    return result;
  };
  const window = async () => {
    if (failed) throw new Error("private native failure");
    return dates;
  };
  const summary = {
    completeRows: rows,
    nominatorCounts: rows,
    dailyValidators: rows,
    async dailyTotals() {
      if (failed) throw new Error("private native failure");
      return ["2026-10-31", "2026-11-01", "other"].map((snapshot_date) => ({
        snapshot_date,
        netuid: 7,
        neuron_count: 1,
        total_stake_tao: 2,
        total_emission_tao: 1,
      }));
    },
    subnetHistory: rows,
  };
  const env = {
    ...dataApiEnv(),
    NEURON_DAILY_VIEW_STORE: { rows, window },
    NEURON_SUMMARY_STORE: summary,
    NEURON_METRIC_STORE: { performanceRows: rows, dailyRows: rows },
  };
  const paths = [
    "subnets/7/concentration/history",
    "subnets/7/turnover",
    "subnets/7/turnover?window=invalid&changes=true",
    "subnets/7/turnover?window=all",
    "subnets/7/history",
    "subnets/7/yield/history",
    "chain/turnover",
    "chain/turnover?window=invalid&limit=3",
    "chain/turnover?limit=",
    "subnets/movers",
    "subnets/movers?limit=",
    "subnets/movers?window=invalid&limit=3",
  ];
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const read = (path: string) =>
    worker.fetch(new Request(`https://example.com/api/v1/${path}`), env, ctx);
  for (const path of paths) expect((await read(path)).status).toBe(200);
  expect((await read("subnets/7/neurons/1")).status).toBe(503);
  for (const state of [
    { startDate: null, endDate: null },
    { startDate: "2026-11-01", endDate: "2026-11-01" },
  ]) {
    dates = state;
    for (const path of [
      "subnets/7/turnover",
      "chain/turnover",
      "subnets/movers",
    ])
      expect((await read(path)).status).toBe(200);
  }
  dates = { startDate: "2026-10-31", endDate: "2026-11-01" };
  for (const path of paths)
    expect(
      (
        await worker.fetch(
          new Request(`https://example.com/api/v1/${path}`),
          dataApiEnv(),
          ctx,
        )
      ).status,
    ).toBe(503);
  const partial = {
    ...dataApiEnv(),
    NEURON_DAILY_VIEW_STORE: { rows, window },
  };
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/v1/chain/turnover"),
        partial,
        ctx,
      )
    ).status,
  ).toBe(503);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    overflow = true;
    expect((await read("subnets/7/turnover")).status).toBe(502);
    overflow = false;
    failed = true;
    for (const path of paths) {
      const response = await read(path);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "data query failed" });
    }
  } finally {
    report.mockRestore();
  }
});

test("daily metric values cross the same finite-number wire boundary as D1", async () => {
  const f = fixture();
  f.parts[0].payload = decoder.encode(
    '{"1":{"stake_tao":1e999},"2":{"stake_tao":-0.0}}',
  );
  const rows = await f.store.rows({ columns: ["uid", "stake_tao"], limit: 10 });
  expect(rows.slice(0, 2)).toEqual([
    { uid: 1, stake_tao: null },
    { uid: 2, stake_tao: 0 },
  ]);
  expect(Object.is(rows[1].stake_tao, -0)).toBe(false);
});
