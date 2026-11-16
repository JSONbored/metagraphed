import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronAggregateStore } from "../src/pg-neuron-aggregates.ts";
import { selectedNeuronAggregateStore } from "../src/neuron-aggregate-store.ts";
import { readNeuronAggregates } from "../src/neuron-snapshot-read.ts";
import type { ReadStoreDb } from "../src/read-store.ts";

const source = new DatabaseSync(":memory:");
const codec = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const decoder = codec;
const payload = (json: string) =>
  source.prepare("SELECT jsonb(?) AS value").get(json)!.value as Uint8Array;
afterAll(() => {
  codec.close();
  source.close();
});

function fixture(
  documents: {
    netuid: string;
    shard: string;
    json: string;
    members: string[];
  }[],
  selectedDecoder: Parameters<typeof createPgNeuronAggregateStore>[1] = decoder,
) {
  const calls: string[] = [];
  let failed = false;
  const rows = documents.flatMap(({ netuid, shard, json, members }) => [
    { kind: 0, netuid, shard, uid: null, payload: payload(json) },
    ...members.map((uid) => ({ kind: 1, netuid, shard, uid, payload: null })),
  ]);
  const read: ReadStoreDb = {
    async query<Row>(sql: string) {
      calls.push(sql);
      if (failed) throw new Error("native unavailable");
      return rows as Row[];
    },
    async first() {
      throw new Error("unexpected first");
    },
  };
  return {
    store: createPgNeuronAggregateStore({ read }, selectedDecoder),
    calls,
    fail() {
      failed = true;
    },
    missingPayload() {
      rows[0]!.payload = null;
    },
  };
}

test("canonical aggregate separates membership counts and duplicate metric folds", async () => {
  const f = fixture([
    { netuid: "8", shard: "0", json: "{}", members: ["9"] },
    {
      netuid: "7",
      shard: "1",
      json: '{"4":{"stake_tao":null,"validator_permit":1},"4":{"stake_tao":null,"validator_permit":1}}',
      members: ["4"],
    },
    {
      netuid: "7",
      shard: "0",
      json: '{"1":{"stake_tao":1e20,"validator_permit":1},"2":{"stake_tao":1,"validator_permit":1},"3":{"stake_tao":-1e20,"validator_permit":0},"01":{"stake_tao":99},"9":"unmatched-primitive"}',
      members: ["1", "2", "3"],
    },
    { netuid: "9", shard: "0", json: "{}", members: [] },
  ]);
  expect(await f.store.aggregateRows()).toEqual([
    {
      netuid: 7,
      uid_count: 4,
      validator_count: 4,
      total_stake_alpha: 1,
      max_stake_alpha: 1e20,
    },
    {
      netuid: 8,
      uid_count: 1,
      validator_count: 0,
      total_stake_alpha: null,
      max_stake_alpha: null,
    },
  ]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toContain("UNION ALL");
});

test("dynamic scalar coercion and MAX storage-class ordering match SQLite", async () => {
  const f = fixture([
    {
      netuid: "7",
      shard: "0",
      json: '{"1":{"stake_tao":5,"validator_permit":"1x"},"2":{"stake_tao":"8","validator_permit":"word"},"3":{"stake_tao":{"x":1},"validator_permit":true},"4":{"stake_tao":null,"validator_permit":false}}',
      members: ["1", "2", "3", "4"],
    },
  ]);
  expect(await f.store.aggregateRows()).toEqual([
    {
      netuid: 7,
      uid_count: 4,
      validator_count: 2,
      total_stake_alpha: 13,
      max_stake_alpha: '{"x":1}',
    },
  ]);
  for (const values of [
    ["0", "0.5"],
    ["0.5", "0"],
    ["-0.5", "0"],
    ["0", "-0.5"],
    ["0", "9e999"],
    ["-9e999", "0"],
    ["-9e999", "-9e999"],
    ["9e999", "0"],
    ["-0.0", "-0.0"],
    ["null", "null"],
    ['"8"', "5"],
  ]) {
    const json = `{${values.map((value, index) => `"${index}":{"stake_tao":${value}}`).join(",")}}`;
    const result = await fixture([
      { netuid: "7", shard: "0", json, members: ["0", "1"] },
    ]).store.aggregateRows();
    const expected = source
      .prepare(
        "SELECT sum(json_extract(value,'$.stake_tao')) AS total,max(json_extract(value,'$.stake_tao')) AS maximum FROM json_each(jsonb(?))",
      )
      .get(json)!;
    const wire = (value: unknown) =>
      typeof value === "number"
        ? Number.isFinite(value)
          ? value === 0
            ? 0
            : value
          : null
        : value;
    expect(result[0]?.total_stake_alpha).toBe(wire(expected.total));
    expect(result[0]?.max_stake_alpha).toBe(wire(expected.maximum));
  }
  const overflow = fixture([
    {
      netuid: "7",
      shard: "0",
      json: '{"0":{"stake_tao":9223372036854775807},"1":{"stake_tao":1}}',
      members: ["0", "1"],
    },
  ]);
  await expect(overflow.store.aggregateRows()).rejects.toThrow("overflow");
});

test("selected aggregate failures remain failures and absent selection retains the source", async () => {
  const f = fixture([]),
    env = { NEURON_AGGREGATE_STORE: f.store };
  const sourceReader = { query: async () => [{ source: true }] };
  expect(selectedNeuronAggregateStore(env)).toBe(f.store);
  expect(await readNeuronAggregates(sourceReader, env)).toEqual([]);
  expect(await readNeuronAggregates(sourceReader, {})).toEqual([
    { source: true },
  ]);
  f.fail();
  await expect(readNeuronAggregates(sourceReader, env)).rejects.toThrow(
    "native unavailable",
  );
  for (const value of [null, undefined, 1, {}])
    expect(selectedNeuronAggregateStore(value)).toBeNull();
  for (const value of [null, undefined, {}, { aggregateRows: 1 }])
    expect(() =>
      selectedNeuronAggregateStore({ NEURON_AGGREGATE_STORE: value }),
    ).toThrow("Invalid");
});

test("MAX compares original text bytes before wire replacement and refuses incomplete decoder metadata", async () => {
  const document = {
    netuid: "7",
    shard: "0",
    json: '{"1":{"stake_tao":"\\ud800"},"2":{"stake_tao":"\\ue000"}}',
    members: ["1", "2"],
  };
  expect(
    (await fixture([document]).store.aggregateRows())[0]?.max_stake_alpha,
  ).toBe("\ue000");
  const invalidBlob = fixture([document], {
    ...decoder,
    metricEntries: () => [
      {
        key: "1",
        values: { stake_tao: new Uint8Array([1]), validator_permit: null },
      },
    ],
  });
  await expect(invalidBlob.store.aggregateRows()).rejects.toThrow(
    "cannot be a BLOB",
  );
  const missingText = fixture([document], {
    ...decoder,
    metricEntries: () => [
      { key: "1", values: { stake_tao: "x", validator_permit: null } },
    ],
  });
  await expect(missingText.store.aggregateRows()).rejects.toThrow(
    "Missing native aggregate text bytes",
  );
  const missingDocument = fixture([document]);
  missingDocument.missingPayload();
  await expect(missingDocument.store.aggregateRows()).rejects.toThrow(
    "Missing native aggregate document",
  );
});
