import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronHistoryStore } from "../src/pg-neuron-history.ts";
import { selectedNeuronHistoryStore } from "../src/neuron-history-store.ts";
import {
  loadAccountPositionHistoryColdTier,
  loadNeuronHistoryColdTier,
} from "../src/neuron-daily-cold-tier.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const source = new DatabaseSync(":memory:");
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const account = "A".repeat(48);
const key = "k" + Buffer.from(account).toString("hex").toUpperCase();
const payload = source
  .prepare("SELECT jsonb(?) AS data")
  .get(
    `{"2":{"active":1,"rank":0.2,"take":0.01},"2":{"active":0,"rank":0.9},"${key}":{"uid":5,"stake_tao":2},"${key}":{"uid":9,"stake_tao":8}}`,
  )!.data as Uint8Array;
afterAll(() => {
  decoder.close();
  source.close();
});

function fixture() {
  let mode: "rows" | "empty" | "failure" = "rows";
  const calls: { sql: string; values: unknown[] }[] = [];
  const read: ReadStoreDb = {
    async query<Row>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (mode === "failure") throw new Error("private database failure");
      return (
        mode === "empty"
          ? []
          : sql.includes("account_position")
            ? [{ account, netuid: "7", snapshot_date: "2026-01-01", payload }]
            : [
                {
                  netuid: "7",
                  uid: "2",
                  hotkey: "member-key",
                  coldkey: null,
                  snapshot_date: "2026-01-01",
                  payload,
                },
              ]
      ) as Row[];
    },
    async first() {
      throw new Error("Unexpected first read");
    },
  };
  return {
    store: createPgNeuronHistoryStore({ read }, decoder),
    calls,
    mode(value: typeof mode) {
      mode = value;
    },
  };
}

test("history capability is explicit and malformed selections fail closed", () => {
  for (const env of [null, undefined, 1, {}])
    expect(selectedNeuronHistoryStore(env)).toBeNull();
  for (const value of [
    null,
    undefined,
    {},
    { neuronRows: 1 },
    { neuronRows() {} },
    { neuronRows() {}, accountRows: 1 },
  ])
    expect(() =>
      selectedNeuronHistoryStore({ NEURON_HISTORY_STORE: value }),
    ).toThrow("Invalid");
  const { store } = fixture();
  expect(selectedNeuronHistoryStore({ NEURON_HISTORY_STORE: store })).toBe(
    store,
  );
});

test("native rows keep first JSON keys, member identities, scalar types and exact date parameters", async () => {
  const f = fixture();
  const range = { lo: "2025-01-01", hi: "2026-02-01" };
  const neurons = await f.store.neuronRows(7, 2, range, 3);
  expect(neurons[0]).toMatchObject({
    uid: 2,
    hotkey: "member-key",
    coldkey: null,
    active: 1,
    rank: 0.2,
    take: 0.01,
    stake_tao: null,
  });
  const positions = await f.store.accountRows(account, 7, range, 4);
  expect(positions[0]).toMatchObject({ uid: 5, stake_tao: 2, active: null });
  expect(f.calls.map((call) => call.values)).toEqual([
    ["7", "2", range.lo, range.hi, 3],
    [account, "7", range.lo, range.hi, 4],
  ]);
  for (const call of f.calls) expect(call.sql).toContain("JOIN app.");
  f.mode("empty");
  expect(await f.store.neuronRows(7, 2, { lo: null, hi: null }, 1)).toEqual([]);
  expect(
    await f.store.accountRows(account, 7, { lo: null, hi: null }, 1),
  ).toEqual([]);
});

test("out-of-range integer identities have no match and invalid bounds refuse", async () => {
  const f = fixture(),
    range = { lo: null, hi: null };
  expect(await f.store.neuronRows(2 ** 63, 2, range, 1)).toEqual([]);
  expect(await f.store.neuronRows(7, -(2 ** 64), range, 1)).toEqual([]);
  expect(await f.store.accountRows(account, 2 ** 63, range, 1)).toEqual([]);
  expect(await f.store.accountRows("a\0b", 7, range, 1)).toEqual([]);
  for (const value of [Infinity, 1.5]) {
    await expect(f.store.neuronRows(value, 2, range, 1)).rejects.toThrow(
      "identity",
    );
    await expect(f.store.accountRows(account, value, range, 1)).rejects.toThrow(
      "identity",
    );
  }
  for (const limit of [0, NaN]) {
    await expect(f.store.neuronRows(7, 2, range, limit)).rejects.toThrow(
      "limit",
    );
    await expect(f.store.accountRows(account, 7, range, limit)).rejects.toThrow(
      "limit",
    );
  }
  expect(f.calls).toEqual([]);
});

test("shared cold readers select native history and preserve failure versus empty", async () => {
  const f = fixture(),
    env = { NEURON_HISTORY_STORE: f.store };
  expect(
    await loadNeuronHistoryColdTier(env, 7, 2, null, "2026-02-01", 5),
  ).toHaveLength(1);
  expect(
    await loadAccountPositionHistoryColdTier(env, account, 7, null, null, 5),
  ).toHaveLength(1);
  f.mode("empty");
  expect(await loadNeuronHistoryColdTier(env, 7, 2, null, null, 5)).toEqual([]);
  f.mode("failure");
  expect(await loadNeuronHistoryColdTier(env, 7, 2, null, null, 5)).toBeNull();
  expect(
    await loadAccountPositionHistoryColdTier(env, account, 7, null, null, 5),
  ).toBeNull();
  expect(await loadNeuronHistoryColdTier(null, 7, 2, null, null, 5)).toBeNull();
  expect(
    await loadAccountPositionHistoryColdTier(null, account, 7, null, null, 5),
  ).toBeNull();
});

test("actual REST handlers use the native capability without a SQL dispatcher", async () => {
  const f = fixture(),
    env = { ...dataApiEnv(), NEURON_HISTORY_STORE: f.store };
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  for (const path of [
    `subnets/7/neurons/2/history`,
    `accounts/${account}/subnets/7/history`,
  ]) {
    const response = await worker.fetch(
      new Request(`https://example.com/api/v1/${path}?window=all`),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ point_count: 1 });
  }
  f.mode("failure");
  const failed = await worker.fetch(
    new Request("https://example.com/api/v1/subnets/7/neurons/2/history"),
    env,
    ctx,
  );
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "data query failed" });
  const missing = await worker.fetch(
    new Request("https://example.com/api/v1/subnets/7/neurons/2/history"),
    dataApiEnv(),
    ctx,
  );
  expect(missing.status).toBe(503);
  const unrelated = await worker.fetch(
    new Request("https://example.com/api/v1/subnets/7/neurons"),
    dataApiEnv(),
    ctx,
  );
  expect(unrelated.status).toBe(503);
});
