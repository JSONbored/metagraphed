import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronSnapshotStore } from "../src/pg-neuron-snapshot.ts";
import { selectedNeuronSnapshotStore } from "../src/neuron-snapshot-store.ts";
import { readSubnetNeuronRows } from "../src/neuron-snapshot-read.ts";
import type { PgSql } from "../src/pg-sql.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import worker, { loadSubnetSnapshotCards } from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const source = new DatabaseSync(":memory:");
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const payload = source.prepare("SELECT jsonb(?) AS data").get('{"1":{"validator_permit":1,"stake_tao":5,"active":1},"1":{"validator_permit":0,"stake_tao":9},"2":{"validator_permit":1,"stake_tao":null}}')!.data as Uint8Array;
const unexpected = { unsafe: () => { throw new Error("unexpected SQL fallback"); } } as unknown as PgSql;
afterAll(() => { decoder.close(); source.close(); });

function fixture() {
  let mode: "rows" | "empty" | "failure" = "rows";
  let owner: string | null = "hot-1";
  let fraction: number | null = 0.5;
  const calls: string[] = [];
  const read: ReadStoreDb = {
    async query<Row>(sql, values) {
      calls.push(sql);
      expect(values).toEqual([7]);
      if (mode === "failure") throw new Error("private connection failure");
      return (mode === "empty" ? [] : [
        { shard: "0", payload, uid: null, hotkey: null, coldkey: null },
        { shard: "0", payload: null, uid: "2", hotkey: "hot-2", coldkey: null },
        { shard: "9", payload: null, uid: "9", hotkey: "orphan", coldkey: null },
        { shard: "0", payload: null, uid: "1", hotkey: "hot-1", coldkey: "cold" },
      ]) as Row[];
    },
    async first<Row>(sql, values) {
      calls.push(sql);
      expect(values).toEqual([7]);
      return (sql.includes("subnet_ownership") ? { owner_hotkey: owner } : { miner_burned_fraction: fraction }) as Row;
    },
  };
  const store = createPgNeuronSnapshotStore({ read }, decoder);
  return { store, calls, mode: (value: typeof mode) => { mode = value; }, owner: (value: typeof owner) => { owner = value; }, fraction: (value: typeof fraction) => { fraction = value; } };
}

test("native selection is explicit and invalid capabilities fail closed", () => {
  for (const value of [undefined, null, 1, {}]) expect(selectedNeuronSnapshotStore(value)).toBeNull();
  for (const value of [undefined, null, {}, { subnetRows: 1 }, { subnetRows() {} }, { subnetRows() {}, burnHotkey: 1 }])
    expect(() => selectedNeuronSnapshotStore({ NEURON_SNAPSHOT_STORE: value })).toThrow("Invalid");
  const f = fixture();
  expect(selectedNeuronSnapshotStore({ NEURON_SNAPSHOT_STORE: f.store })).toBe(f.store);
});

test("normal subnet reader keeps last JSON keys, accepted identities, shard matching and filters", async () => {
  const f = fixture();
  const env = { NEURON_SNAPSHOT_STORE: f.store };
  const rows = await readSubnetNeuronRows(unexpected, env, 7);
  expect(rows.map((row) => [row.uid, row.hotkey, row.stake_tao])).toEqual([[1, "hot-1", 9], [2, "hot-2", null]]);
  expect((await readSubnetNeuronRows(unexpected, env, 7, true)).map((row) => row.uid)).toEqual([2]);
  expect(f.calls.every((sql) => sql.includes("UNION ALL"))).toBe(true);
  f.mode("empty");
  expect(await readSubnetNeuronRows(unexpected, env, 7)).toEqual([]);
  f.mode("failure");
  await expect(readSubnetNeuronRows(unexpected, env, 7)).rejects.toThrow("private connection failure");
});

test("burn ownership keeps missing, zero, positive and nonfinite semantics", async () => {
  const f = fixture();
  expect(await f.store.burnHotkey(7)).toBe("hot-1");
  for (const value of [0, null, NaN, Infinity, -1]) { f.fraction(value); expect(await f.store.burnHotkey(7)).toBeNull(); }
  f.owner(null);
  expect(await f.store.burnHotkey(7)).toBeNull();
});

test("normal REST route and compound MCP cards reach the native capability", async () => {
  const f = fixture();
  const env = { ...dataApiEnv(), NEURON_SNAPSHOT_STORE: f.store };
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const response = await worker.fetch(new Request("https://example.com/api/v1/subnets/7/metagraph"), env, ctx);
  expect(response.status).toBe(200);
  expect((await response.json() as { neuron_count: number }).neuron_count).toBe(2);
  const filtered = await worker.fetch(new Request("https://example.com/api/v1/subnets/7/metagraph?validator_permit=true"), env, ctx);
  expect(filtered.status).toBe(200);
  expect((await filtered.json() as { neuron_count: number }).neuron_count).toBe(1);
  const cards = await loadSubnetSnapshotCards(unexpected, env, 7);
  expect(cards).toHaveProperty("validators");
  expect(cards).toHaveProperty("concentration");
  f.mode("failure");
  const failed = await worker.fetch(new Request("https://example.com/api/v1/subnets/7/metagraph"), env, ctx);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "data query failed" });
});
