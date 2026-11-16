import { afterAll, expect, test, vi } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import {
  createPgValidatorHistoryStore,
  type ValidatorHistoryLimits,
} from "../src/pg-validator-history.ts";
import { selectedValidatorHistoryStore } from "../src/validator-history-store.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1048576 });
afterAll(() => decoder.close());
function fixture(limits: ValidatorHistoryLimits = {}) {
  const parts = [
    ...[
      {
        netuid: "0",
        json: '{"1":{"stake_tao":9007199254740993,"emission_tao":1,"validator_permit":1}}',
      },
      {
        netuid: "7",
        json: '{"1":{"stake_tao":"2x","emission_tao":3.5,"validator_permit":1,"take":0.1}}',
      },
      {
        netuid: "8",
        json: '{"1":{"stake_tao":4,"emission_tao":3,"validator_permit":1}}',
      },
    ].flatMap(({ netuid, json }) => [
      {
        kind: 0,
        netuid,
        day: "2026-11-01",
        shard: "0",
        uid: null,
        payload: decoder.encode(json) as Uint8Array | null,
        overflow: false,
        total_stake_tao: null,
        tao_in_pool_tao: null,
        alpha_in_pool: null,
      },
      {
        kind: 1,
        netuid,
        day: "2026-11-01",
        shard: "0",
        uid: "1",
        payload: null,
        overflow: false,
        total_stake_tao: null,
        tao_in_pool_tao: null,
        alpha_in_pool: null,
      },
    ]),
    {
      kind: 2,
      netuid: "7",
      day: "2026-11-01",
      shard: null,
      uid: null,
      payload: null,
      overflow: false,
      total_stake_tao: 100,
      tao_in_pool_tao: 2,
      alpha_in_pool: 4,
    },
  ];
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let empty = false,
    excess = false;
  let pages: (typeof parts)[] | undefined;
  const transaction: PgStoreRuntime["transaction"] = async (
    callback,
    options,
  ) => {
    expect(options).toEqual({ isolation: "repeatable read" });
    return callback({
      async query<Row>(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        if (pages) return (pages.shift() ?? []) as Row[];
        return (
          empty
            ? []
            : excess
              ? Array(200001).fill(parts[1])
              : sql.includes("m.netuid=$")
                ? parts.filter((part) => part.netuid === values?.at(-1))
                : parts
        ) as Row[];
      },
      async first() {
        throw new Error("unused");
      },
      async run() {
        throw new Error("unused");
      },
    });
  };
  return {
    store: createPgValidatorHistoryStore({ transaction }, decoder, limits),
    runtime: { transaction },
    parts,
    calls,
    clear() {
      empty = true;
    },
    exceed() {
      excess = true;
    },
    pages(value: (typeof parts)[]) {
      pages = value;
    },
  };
}

test("retains integer precision until mixed-storage history aggregation", async () => {
  const f = fixture();
  expect(await f.store.rows("hot", null, 400)).toEqual([
    {
      snapshot_date: "2026-11-01",
      subnet_count: 3,
      total_stake_tao: 9007199254740994,
      total_emission_tao: 2.75,
    },
  ]);
  const scoped = await f.store.rows("hot", "2026-10-01", 400, 7);
  expect(scoped).toEqual([
    {
      snapshot_date: "2026-11-01",
      subnet_count: 1,
      netuid: 7,
      uid: 1,
      stake_alpha: "2x",
      emission_alpha: 3.5,
      validator_trust: null,
      consensus: null,
      dividends: null,
      take: 0.1,
      validator_permit: 1,
      subnet_total_stake: 100,
      total_stake_tao: 1,
      total_emission_tao: 1.75,
    },
  ]);
  expect(f.calls[1].values).toEqual(["hot", "2026-10-01", "7"]);
  expect(f.calls[0].sql).toContain("budget.bytes");
  const unpriced = fixture();
  unpriced.parts.splice(
    0,
    unpriced.parts.length,
    ...unpriced.parts.filter((part) => part.netuid === "8"),
  );
  expect(await unpriced.store.rows("hot", null, 400)).toEqual([
    {
      snapshot_date: "2026-11-01",
      subnet_count: 1,
      total_stake_tao: null,
      total_emission_tao: null,
    },
  ]);
  f.clear();
  expect(await f.store.rows("hot", null, 400)).toEqual([]);
});

test("validates public bounds and refuses incomplete source populations", async () => {
  const f = fixture();
  for (const [hotkey, cutoff, limit, netuid] of [
    [undefined as never, null, 1, undefined],
    ["a", 1 as never, 1, undefined],
    ["a", null, 0, undefined],
    ["a", null, 10001, undefined],
    ["a", null, 1, 1.5],
    ["a", null, 1, Infinity],
  ] as const)
    await expect(f.store.rows(hotkey, cutoff, limit, netuid)).rejects.toThrow(
      "Invalid",
    );
  expect(await f.store.rows("a", null, 1, 1e30)).toEqual([]);
  expect(await f.store.rows("a", null, 1, -1e30)).toEqual([]);
  await f.store.rows("a\0b", null, 1);
  expect(f.calls.at(-1)?.values).toEqual([Buffer.from("a\0b")]);
  f.parts[0].overflow = true;
  await expect(f.store.rows("hot", null, 1)).rejects.toThrow("budget");
  f.parts[0].overflow = false;
  f.parts[0].payload = null;
  await expect(f.store.rows("hot", null, 1)).rejects.toThrow("document");
  f.exceed();
  await expect(f.store.rows("hot", null, 1)).rejects.toThrow("budget");
  expect(
    selectedValidatorHistoryStore({ VALIDATOR_HISTORY_STORE: f.store }),
  ).toBe(f.store);
  for (const value of [null, {}, 1])
    expect(selectedValidatorHistoryStore(value)).toBeNull();
  expect(() =>
    selectedValidatorHistoryStore({ VALIDATOR_HISTORY_STORE: {} }),
  ).toThrow("Invalid");
  expect(() =>
    selectedValidatorHistoryStore({ VALIDATOR_HISTORY_STORE: null }),
  ).toThrow("Invalid");
});

test("requires explicit bounded resource limits and complete source documents", async () => {
  for (const limits of [
    { maxSourceRows: 0 },
    { maxSourceRows: 200001 },
    { maxSourceRows: 1.5 },
    { maxPageBytes: 0 },
    { maxPageBytes: 33554433 },
    { maxPageBytes: 1.5 },
    { pageRows: 0 },
    { pageRows: 513 },
    { pageRows: 1.5 },
    { maxDurationMillis: 0 },
    { maxDurationMillis: 60001 },
    { maxDurationMillis: 1.5 },
  ])
    expect(() => fixture(limits)).toThrow("bounds");
  const excessive = fixture({ maxSourceRows: 1 });
  await expect(excessive.store.rows("hot", null, 400)).rejects.toThrow(
    "complete source budget",
  );
  const malformed = fixture();
  malformed.parts[0].day = null as never;
  await expect(malformed.store.rows("hot", null, 400)).rejects.toThrow(
    "source day",
  );
  const missing = fixture();
  missing.parts.splice(0, 1);
  await expect(missing.store.rows("hot", null, 400)).rejects.toThrow(
    "projection",
  );
});

test("continues one aggregate day across keyset pages and stops at the requested boundary", async () => {
  const f = fixture({ pageRows: 1 });
  const page = (netuids: string[]) =>
    f.parts.filter((part) => part.kind !== 1 || netuids.includes(part.netuid));
  f.pages([
    page(["7", "0"]),
    page(["8", "7"]),
    [...page(["8"]), { ...f.parts[1], day: "2026-10-31" }],
    [{ ...f.parts[1], day: "2026-10-31" }],
  ]);
  expect(await f.store.rows("hot", null, 1)).toEqual([
    {
      snapshot_date: "2026-11-01",
      subnet_count: 3,
      total_stake_tao: 9007199254740994,
      total_emission_tao: 2.75,
    },
  ]);
  expect(f.calls).toHaveLength(4);
  expect(f.calls[1].values).toEqual(["hot", "2026-11-01", "0", "1"]);
  const scoped = fixture({ pageRows: 1 });
  scoped.pages([page(["8"])]);
  expect((await scoped.store.rows("hot", null, 1, 8))[0]).toMatchObject({
    subnet_total_stake: null,
    total_stake_tao: null,
    total_emission_tao: null,
  });
});

test("refuses expired work before querying and after the final page", async () => {
  const clock = vi.spyOn(performance, "now");
  try {
    clock.mockReturnValueOnce(0).mockReturnValue(1);
    const f = fixture({ maxDurationMillis: 1 });
    await expect(f.store.rows("hot", null, 400)).rejects.toThrow("deadline");
    expect(f.calls).toHaveLength(0);
    clock
      .mockReset()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    await expect(f.store.rows("hot", null, 400)).rejects.toThrow("deadline");
    expect(f.calls).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

test("keeps same-network UID order, rejects malformed metrics and skips lost unscoped permits", async () => {
  const f = fixture();
  f.parts[0].payload = decoder.encode(
    '{"1":{"validator_permit":0},"2":{"stake_tao":2,"emission_tao":2,"validator_permit":1}}',
  );
  f.parts.push({
    kind: 1,
    netuid: "0",
    day: "2026-11-01",
    shard: "0",
    uid: "2",
    payload: null,
    overflow: false,
    total_stake_tao: null,
    tao_in_pool_tao: null,
    alpha_in_pool: null,
  });
  expect(await f.store.rows("hot", null, 400)).toEqual([
    {
      snapshot_date: "2026-11-01",
      subnet_count: 3,
      total_stake_tao: 3,
      total_emission_tao: 3.75,
    },
  ]);
  const bad = createPgValidatorHistoryStore(f.runtime, {
    ...decoder,
    memberMetrics() {
      return [
        {
          key: "1",
          values: {
            stake_tao: new Uint8Array([0]),
            emission_tao: null,
            validator_permit: 1n,
            validator_trust: null,
            consensus: null,
            dividends: null,
            take: null,
          },
        },
      ];
    },
  });
  await expect(bad.rows("hot", null, 1, 7)).rejects.toThrow("BLOB");
});

test("selects typed history and preserves request normalization and opaque errors", async () => {
  const calls: unknown[][] = [];
  const store = {
    async rows(...args: unknown[]) {
      calls.push(args);
      return [];
    },
  };
  const env = { ...dataApiEnv(), VALIDATOR_HISTORY_STORE: store };
  const read = (path: string, selected: object = env) =>
    worker.fetch(
      new Request(`https://example.com/api/v1/${path}`),
      { ...dataApiEnv(), ...selected },
      { waitUntil() {} },
    );
  for (const path of [
    "validators/hot/history",
    "validators/hot/history?netuid=7&window=all",
    "validators/hot/history?netuid=bad",
    "validators/hot/history?netuid=-1",
  ])
    expect((await read(path)).status).toBe(200);
  expect(calls[1][3]).toBe(7);
  expect(calls[2][3]).toBeUndefined();
  expect(calls[3][3]).toBeUndefined();
  expect((await read("validators/hot/history", {})).status).toBe(503);
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await read("validators/%E0%A4%A/history")).status).toBe(502);
    expect(
      (
        await read("validators/hot/history", {
          ...env,
          VALIDATOR_HISTORY_STORE: {},
        })
      ).status,
    ).toBe(502);
  } finally {
    spy.mockRestore();
  }
});
