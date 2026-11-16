import { afterAll, expect, test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronLiveStore } from "../src/pg-neuron-live.ts";
import { selectedNeuronLiveStore } from "../src/neuron-live-store.ts";
import {
  readNewestNeuronCapture,
  readNeuronEconomicsRows,
  readNeuronDirectoryRows,
} from "../src/neuron-snapshot-read.ts";
import type { PgSql } from "../src/pg-sql.ts";
import type { ReadStoreDb } from "../src/read-store.ts";

const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
afterAll(() => decoder.close());
function fixture(
  documents: {
    netuid: string;
    shard?: string;
    json: string;
    members: [string, string | null][];
  }[],
  codec = decoder,
) {
  let failed = false;
  const calls: { sql: string; params: unknown }[] = [];
  const rows = documents.flatMap(({ netuid, shard = "0", json, members }) => [
    {
      kind: 0,
      netuid,
      shard,
      uid: null,
      hotkey: null,
      coldkey: null,
      payload: decoder.encode(json) as Uint8Array | null,
    },
    ...members.map(([uid, hotkey]) => ({
      kind: 1,
      netuid,
      shard,
      uid,
      hotkey,
      coldkey: "cold",
      payload: null,
    })),
  ]);
  const read: ReadStoreDb = {
    async query<Row>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params });
      if (failed) throw new Error("native unavailable");
      return rows.filter(
        (row) => !params?.length || row.netuid === params[0],
      ) as Row[];
    },
    async first() {
      throw new Error("unexpected first");
    },
  };
  return {
    store: createPgNeuronLiveStore({ read }, codec),
    calls,
    rows,
    fail() {
      failed = true;
    },
  };
}

test("freshness uses canonical text keys and compares original text before wire replacement", async () => {
  const f = fixture([
    {
      netuid: "7",
      json: '{"01":{"captured_at":100},"1":{"captured_at":1},"2":{"captured_at":"\\ud800"},"3":{"captured_at":"\\ue000"}}',
      members: [
        ["1", "a"],
        ["2", "a"],
        ["3", "a"],
      ],
    },
  ]);
  expect(Number.isNaN(await f.store.newestCapture())).toBe(true);
  expect(f.calls[0].sql).toContain("UNION ALL");
  for (const [json, expected] of [
    ["{}", 0],
    ['{"1":{"captured_at":9e999}}', 0],
    ['{"1":{"captured_at":-0.0}}', 0],
    ['{"1":{"captured_at":3},"01":{"captured_at":100}}', 3],
    ['{"1":{"captured_at":"24"}}', 24],
  ] as const)
    expect(
      await fixture([
        { netuid: "1", json, members: [["1", null]] },
      ]).store.newestCapture(),
    ).toBe(expected);
  expect(
    await fixture([
      { netuid: "1", json: '[{"captured_at":99}]', members: [["0", "a"]] },
    ]).store.newestCapture(),
  ).toBe(0);
});

test("economics retains cast-key multiplicity and multi-path JSON reparsing", async () => {
  const f = fixture([
    {
      netuid: "8",
      json: '{"1":{"active":true,"take":{"x":1,"x":2}}}',
      members: [["1", null]],
    },
    {
      netuid: "7",
      shard: "2",
      json: '{"2":{"stake_tao":2},"02":{"stake_tao":3},"2.9":{"stake_tao":4},"0":{"active":false,"take":[1,null]}}',
      members: [
        ["2", "key"],
        ["0", null],
      ],
    },
    { netuid: "0", json: '{"1":{"stake_tao":999}}', members: [["1", "root"]] },
    { netuid: "9", json: '{"1":"orphan malformed"}', members: [] },
  ]);
  const rows = await f.store.economicsRows();
  expect(
    rows.map((row) => [
      row.netuid,
      row.uid,
      row.hotkey,
      row.stake_tao,
      row.active,
      row.take,
    ]),
  ).toEqual([
    [7, 0, null, null, 0, "[1,null]"],
    [7, 2, "key", 2, null, null],
    [7, 2, "key", 3, null, null],
    [7, 2, "key", 4, null, null],
    [8, 1, null, null, 1, '{"x":2}'],
  ]);
  expect(await f.store.economicsRows(0)).toEqual([
    {
      uid: 1,
      hotkey: "root",
      stake_tao: 999,
      validator_permit: null,
      dividends: null,
      active: null,
      take: null,
    },
  ]);
  expect(f.calls.at(-1)?.params).toEqual(["0"]);
  expect(f.calls.at(-1)?.sql).toContain("d.netuid=$1::bigint");
  for (const identity of [NaN, Infinity, 1.5])
    await expect(f.store.economicsRows(identity)).rejects.toThrow("identity");
  expect(await f.store.economicsRows(1e30)).toEqual([]);
  expect(await f.store.economicsRows(-1e30)).toEqual([]);
  await expect(
    fixture([
      { netuid: "1", json: '{"1":null}', members: [["1", "a"]] },
    ]).store.economicsRows(),
  ).rejects.toThrow();
});

test("directory preserves exact scalar sorting, casts, strict permits and null-hotkey exclusion", async () => {
  const f = fixture([
    {
      netuid: "8",
      json: '{"1":{"stake_tao":5,"validator_permit":1,"take":0.2},"2":{"stake_tao":1,"validator_permit":true}}',
      members: [
        ["1", "a"],
        ["2", "a"],
      ],
    },
    {
      netuid: "7",
      json: '{"1":{"stake_tao":5,"validator_permit":1.0},"01":{"stake_tao":"8","validator_permit":2},"2":{"stake_tao":null,"validator_permit":"1"},"3":{"stake_tao":9e999,"validator_permit":false},"4":{},"5":{"stake_tao":9007199254740993,"validator_permit":true}}',
      members: [
        ["1", "a"],
        ["2", "b"],
        ["3", "a"],
        ["4", null],
        ["5", "a"],
      ],
    },
  ]);
  expect(
    (await f.store.directoryRows()).map((row) => [
      row.netuid,
      row.uid,
      row.stake_tao,
    ]),
  ).toEqual([
    [7, 1, "8"],
    [7, 3, null],
    [7, 5, 9007199254740992],
    [7, 1, 5],
    [8, 1, 5],
    [8, 2, 1],
    [7, 2, null],
  ]);
  const validators = await f.store.directoryRows(true);
  expect(validators.map((row) => [row.netuid, row.uid])).toEqual([
    [7, 5],
    [7, 1],
    [8, 1],
    [8, 2],
  ]);
  expect(validators[2].take).toBe(0.2);
  expect(validators[0]).not.toHaveProperty("validator_permit");
  expect(
    await fixture([
      { netuid: "1", json: '[{"stake_tao":1}]', members: [["0", "array"]] },
    ]).store.directoryRows(),
  ).toHaveLength(1);
});

test("selected live readers fail closed and absent selection retains legacy readers", async () => {
  const f = fixture([]),
    env = { NEURON_LIVE_STORE: f.store };
  const sql = { unsafe: async () => [{ captured_at: 2 }] } as unknown as PgSql;
  const db = { query: async () => [{ legacy: true }] };
  expect(selectedNeuronLiveStore(env)).toBe(f.store);
  expect(await readNewestNeuronCapture(sql, env)).toBe(0);
  expect(await readNeuronEconomicsRows(db, env)).toEqual([]);
  expect(await readNeuronDirectoryRows(sql, env)).toEqual([]);
  expect(await readNewestNeuronCapture(sql, {})).toBe(2);
  expect(await readNeuronEconomicsRows(db, {})).toEqual([{ legacy: true }]);
  expect(await readNeuronDirectoryRows(sql, {})).toEqual([{ captured_at: 2 }]);
  f.fail();
  await expect(readNewestNeuronCapture(sql, env)).rejects.toThrow(
    "native unavailable",
  );
  await expect(readNeuronEconomicsRows(db, env)).rejects.toThrow(
    "native unavailable",
  );
  await expect(readNeuronDirectoryRows(sql, env)).rejects.toThrow(
    "native unavailable",
  );
  for (const value of [null, undefined, 1, {}])
    expect(selectedNeuronLiveStore(value)).toBeNull();
  for (const value of [
    null,
    undefined,
    {},
    { newestCapture() {}, economicsRows() {} },
  ])
    expect(() => selectedNeuronLiveStore({ NEURON_LIVE_STORE: value })).toThrow(
      "Invalid",
    );
});

test("native metric corruption is rejected instead of falling through to source reads", async () => {
  const documents = [
    {
      netuid: "7",
      json: '{"1":{}}',
      members: [["1", "a"]] as [string, string | null][],
    },
  ];
  for (const value of [new Uint8Array([1]), "missing bytes"])
    await expect(
      fixture(documents, {
        ...decoder,
        metricEntries: () => [{ key: "1", values: { captured_at: value } }],
      }).store.newestCapture(),
    ).rejects.toThrow(value instanceof Uint8Array ? "BLOB" : "text bytes");
  const f = fixture(documents);
  f.rows[0].payload = null;
  await expect(f.store.newestCapture()).rejects.toThrow(
    "Missing native live document",
  );
});

test("validator predicates retain malformed orphan failures before joining members", async () => {
  for (const [json, members] of [
    ['{"1":{},"9":"not-json"}', [["1", "a"]]],
    ['"not-json"', []],
    ['{"9":"not-json"}', []],
  ] as [string, [string, string | null][]][]) {
    const f = fixture([{ netuid: "7", json, members }]);
    await expect(f.store.directoryRows(true)).rejects.toThrow("malformed");
    expect(await f.store.directoryRows(false)).toHaveLength(members.length);
  }
});

test("directory ties use exact UID order and hotkey order across out-of-order shards", async () => {
  const f = fixture([
    {
      netuid: "7",
      shard: "2",
      json: '{"2":{"stake_tao":1}}',
      members: [["2", "a"]],
    },
    {
      netuid: "7",
      shard: "0",
      json: '{"1":{"stake_tao":1},"4":{"stake_tao":1}}',
      members: [
        ["1", "a"],
        ["4", "z"],
      ],
    },
    {
      netuid: "7",
      shard: "1",
      json: '{"3":{"stake_tao":1}}',
      members: [["3", "a"]],
    },
  ]);
  expect(
    (await f.store.directoryRows()).map((row) => [row.hotkey, row.uid]),
  ).toEqual([
    ["a", 1],
    ["a", 2],
    ["a", 3],
    ["z", 4],
  ]);
});
