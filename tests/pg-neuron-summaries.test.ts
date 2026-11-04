import { afterAll, expect, test } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronSummaryStore } from "../src/pg-neuron-summaries.ts";
import { selectedNeuronSummaryStore } from "../src/neuron-summary-store.ts";
import {
  readCompleteNeuronRows,
  readDirectoryNominatorCounts,
  readNeuronDailyValidators,
  readNeuronDailyTotals,
  readSubnetDailyHistory,
} from "../src/neuron-snapshot-read.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import type { PgSql } from "../src/pg-sql.ts";

const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
afterAll(() => decoder.close());
type Receipt = {
  captured_at: string;
  expected_rows: string;
  received_rows: string;
  completed_at: string | null;
};
function fixture(
  documents: {
    netuid: string;
    day?: string;
    shard?: string;
    json: string;
    members: [string, string | null][];
  }[],
  receipts: Receipt[] = [],
  codec = decoder,
) {
  let failed = false;
  let stamp: string | null = "9";
  const calls: { sql: string; params: unknown }[] = [];
  const rows = documents.flatMap(
    ({ netuid, day = "", shard = "0", json, members }) => [
      {
        kind: 0,
        netuid,
        day,
        shard,
        uid: null,
        hotkey: null,
        payload: decoder.encode(json) as Uint8Array | null,
        receipt: null,
      },
      ...members.map(([uid, hotkey]) => ({
        kind: 1,
        netuid,
        day,
        shard,
        uid,
        hotkey,
        payload: null,
        receipt: null,
      })),
    ],
  );
  const read: ReadStoreDb = {
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (failed) throw new Error("native unavailable");
      if (sql.includes("unnest"))
        return (params[0] as string[]).map((hotkey) => ({
          hotkey,
          nominator_count: hotkey === "a" ? "0" : null,
          scan_at: stamp,
        })) as Row[];
      return [
        ...rows.filter((row) => {
          if (
            sql.includes("app.neuron_daily_documents")
              ? row.day === ""
              : row.day !== ""
          )
            return false;
          if (sql.includes("d.day IN")) return params.includes(row.day);
          if (sql.includes("d.netuid=$1"))
            return (
              row.netuid === params[0] &&
              (!sql.includes("d.day >=") || row.day >= String(params[1])) &&
              (!sql.includes("d.day <") || row.day < String(params.at(-1)))
            );
          return true;
        }),
        ...receipts.map((receipt) => ({ kind: 2, receipt })),
      ] as Row[];
    },
    async first() {
      throw new Error("Unexpected first");
    },
  };
  return {
    store: createPgNeuronSummaryStore({ read }, codec),
    calls,
    rows,
    fail() {
      failed = true;
    },
    clearStamp() {
      stamp = null;
    },
  };
}

test("daily summaries preserve duplicate integer keys, source truth and scalar sums", async () => {
  const f = fixture([
    {
      netuid: "8",
      day: "2026-01-02",
      json: '{"1":{"stake_tao":null,"emission_tao":null}}',
      members: [["1", null]],
    },
    {
      netuid: "7",
      day: "2026-01-01",
      shard: "2",
      json: '{"3":{"stake_tao":-1e20,"validator_permit":1}}',
      members: [["3", "c"]],
    },
    {
      netuid: "7",
      day: "2026-01-01",
      shard: "0",
      json: '{"1":{"stake_tao":1e20,"emission_tao":1.5,"validator_permit":true},"01":{"stake_tao":1,"emission_tao":"2x","validator_permit":"1x"},"2":{"stake_tao":null,"emission_tao":0,"validator_permit":0.0}}',
      members: [
        ["1", "a"],
        ["2", null],
      ],
    },
    { netuid: "7", day: "2026-01-03", json: "{}", members: [["1", "a"]] },
  ]);
  expect(await f.store.dailyTotals("2026-01-01", "2026-01-02")).toEqual([
    {
      netuid: 7,
      snapshot_date: "2026-01-01",
      neuron_count: 4,
      validator_count: 3,
      total_stake_tao: 1,
      total_emission_tao: 3.5,
    },
    {
      netuid: 8,
      snapshot_date: "2026-01-02",
      neuron_count: 1,
      validator_count: 0,
      total_stake_tao: null,
      total_emission_tao: null,
    },
  ]);
  expect(
    (await f.store.dailyValidators("2026-01-01", "2026-01-02")).map((row) => [
      row.netuid,
      row.hotkey,
      row.validator_permit,
    ]),
  ).toEqual([
    [7, "a", 1],
    [7, "c", 1],
  ]);
  expect(await f.store.subnetHistory(7, "2026-01-01", 1, "2026-01-02")).toEqual(
    [
      {
        snapshot_date: "2026-01-01",
        neuron_count: 4,
        validator_count: 3,
        total_stake_tao: 1,
        total_emission_tao: 3.5,
      },
    ],
  );
  expect(f.calls.at(-1)?.params).toEqual(["7", "2026-01-01", "2026-01-02"]);
  expect(await f.store.subnetHistory(7, null, 2)).toHaveLength(1);
  for (const [netuid, limit] of [
    [1.5, 2],
    [Infinity, 1],
    [7, 0],
    [7, 1.2],
  ])
    await expect(f.store.subnetHistory(netuid, null, limit)).rejects.toThrow(
      "bounds",
    );
  expect(await f.store.subnetHistory(1e30, null, 1)).toEqual([]);
  expect(await f.store.subnetHistory(-1e30, null, 1)).toEqual([]);
});

test("complete snapshots require matching newest receipt and exact distinct entry count", async () => {
  const receipt = {
    captured_at: "1000000000000",
    expected_rows: "3",
    received_rows: "3",
    completed_at: "1",
  };
  const docs = [
    {
      netuid: "8",
      json: '{"1":{"captured_at":1000000000000,"block_number":null}}',
      members: [["1", null]] as [string, string | null][],
    },
    {
      netuid: "7",
      json: '{"1":{"captured_at":1000000000000,"block_number":1},"01":{"captured_at":1000000000000,"block_number":2},"2":{"captured_at":999999999999,"block_number":99}}',
      members: [
        ["1", "a"],
        ["2", "b"],
      ] as [string, string | null][],
    },
  ];
  expect(await fixture(docs, [receipt]).store.completeRows()).toEqual([
    { netuid: 7, block_number: 2 },
    { netuid: 8, block_number: null },
  ]);
  for (const change of [
    { expected_rows: "2" },
    { received_rows: "2" },
    { completed_at: null },
  ])
    expect(
      await fixture(docs, [{ ...receipt, ...change }]).store.completeRows(),
    ).toEqual([]);
  expect(await fixture(docs).store.completeRows()).toEqual([]);
  expect(await fixture([]).store.completeRows()).toEqual([]);
  expect(
    await fixture(
      [{ netuid: "7", json: '{"1":{}}', members: [["1", "a"]] }],
      [receipt],
    ).store.completeRows(),
  ).toEqual([]);
  expect(
    await fixture(
      [
        {
          netuid: "7",
          json: '{"1":{"captured_at":"1000000000000","block_number":"8"},"2":{"captured_at":1000000000000,"block_number":9}}',
          members: [
            ["1", "a"],
            ["2", "b"],
          ],
        },
      ],
      [{ ...receipt, expected_rows: "1" }],
    ).store.completeRows(),
  ).toEqual([{ netuid: 7, block_number: "8" }]);
});

test("nominator reads retain input order, confirmed zero, missing keys and whole-table stamp", async () => {
  const f = fixture([]);
  expect(await f.store.nominatorCounts(["missing", "a", "missing"])).toEqual([
    { hotkey: "missing", nominator_count: null, scan_at: 9 },
    { hotkey: "a", nominator_count: 0, scan_at: 9 },
  ]);
  expect(f.calls[0].params).toEqual([["missing", "a"]]);
  expect(await f.store.nominatorCounts([])).toEqual([]);
  f.clearStamp();
  expect(await f.store.nominatorCounts(["a"])).toEqual([
    { hotkey: "a", nominator_count: 0, scan_at: null },
  ]);
});

test("summary selectors are explicit and selected failures never fall through", async () => {
  const f = fixture([]),
    env = { NEURON_SUMMARY_STORE: f.store },
    sql = {} as PgSql;
  expect(selectedNeuronSummaryStore(env)).toBe(f.store);
  expect(await readCompleteNeuronRows(env)).toEqual([]);
  expect(await readDirectoryNominatorCounts(sql, env, [])).toEqual([]);
  expect(await readNeuronDailyValidators(sql, env, "a", "b")).toEqual([]);
  expect(await readNeuronDailyTotals(sql, env, "a", "b")).toEqual([]);
  expect(await readSubnetDailyHistory(sql, env, 7, null, 1)).toEqual([]);
  expect(await readCompleteNeuronRows({})).toBeNull();
  f.fail();
  for (const operation of [
    () => readCompleteNeuronRows(env),
    () => readDirectoryNominatorCounts(sql, env, []),
    () => readNeuronDailyValidators(sql, env, "a", "b"),
    () => readNeuronDailyTotals(sql, env, "a", "b"),
    () => readSubnetDailyHistory(sql, env, 7, null, 1),
  ])
    await expect(operation()).rejects.toThrow("native unavailable");
  for (const value of [undefined, null, 1, {}])
    expect(selectedNeuronSummaryStore(value)).toBeNull();
  for (const value of [undefined, null, {}, { completeRows() {} }])
    expect(() =>
      selectedNeuronSummaryStore({ NEURON_SUMMARY_STORE: value }),
    ).toThrow("Invalid");
});

test("malformed documents and missing native metric metadata remain failures", async () => {
  const docs = [
    {
      netuid: "7",
      json: "{}",
      members: [["1", "a"]] as [string, string | null][],
    },
  ];
  for (const captured_at of [new Uint8Array([1]), "text"]) {
    const f = fixture(docs, [], {
      ...decoder,
      metricEntries: () => [
        { key: "1", integerKey: 1n, values: { captured_at } },
      ],
    });
    await expect(f.store.completeRows()).rejects.toThrow(
      captured_at instanceof Uint8Array ? "BLOB" : "text bytes",
    );
  }
  const f = fixture(docs);
  f.rows[0].payload = null;
  await expect(f.store.completeRows()).rejects.toThrow(
    "Missing native summary document",
  );
  const broken = fixture([
    { netuid: "7", day: "d", json: '{"9":"malformed"}', members: [] },
  ]);
  await expect(broken.store.dailyValidators("d", "e")).rejects.toThrow(
    "malformed",
  );
});

test("integer receipt joins use SQLite affinity while preserving scalar value identity", () => {
  for (const value of [1n, 1, 1.0, "1", " 1 ", "1.0", "1e0"])
    expect(decoder.matchesInteger(value, 1n)).toBe(true);
  for (const value of [null, 2n, 1.5, "1x", "01x", new Uint8Array([49])])
    expect(decoder.matchesInteger(value, 1n)).toBe(false);
  const closed = createSqliteDocumentDecoder({ maxAuditBytes: 1 });
  closed.close();
  expect(() => closed.matchesInteger(1n, 1n)).toThrow("closed");
});

test("history sorts multiple days before limiting and complete block maxima do not decrease", async () => {
  const history = fixture(
    ["2026-01-02", "2026-01-03", "2026-01-01"].map((day) => ({
      netuid: "7",
      day,
      json: '{"1":{}}',
      members: [["1", "a"]] as [string, string | null][],
    })),
  );
  expect(
    (await history.store.subnetHistory(7, null, 2)).map(
      (row) => row.snapshot_date,
    ),
  ).toEqual(["2026-01-03", "2026-01-02"]);
  const live = fixture(
    [
      {
        netuid: "7",
        json: '{"1":{"captured_at":1,"block_number":9},"01":{"captured_at":1,"block_number":1},"001":{"captured_at":1,"block_number":9}}',
        members: [["1", "a"]],
      },
    ],
    [
      {
        captured_at: "1",
        expected_rows: "3",
        received_rows: "3",
        completed_at: "2",
      },
    ],
  );
  expect(await live.store.completeRows()).toEqual([
    { netuid: 7, block_number: 9 },
  ]);
});
