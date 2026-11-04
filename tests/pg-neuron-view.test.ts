import { afterAll, expect, test, vi } from "vitest";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { createPgNeuronViewStore } from "../src/pg-neuron-view.ts";
import { selectedNeuronViewStore } from "../src/neuron-view-store.ts";
import type { NeuronViewQuery } from "../src/neuron-view-store.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
afterAll(() => decoder.close());
function fixture(codec = decoder) {
  let fail = false;
  const calls: { sql: string; params: unknown }[] = [];
  const parts = [
    {
      kind: 0,
      netuid: "7",
      shard: "1",
      uid: null,
      hotkey: null,
      coldkey: null,
      payload: decoder.encode(
        '{"3":{"stake_tao":2,"validator_permit":1}}',
      ) as Uint8Array | null,
    },
    {
      kind: 1,
      netuid: "7",
      shard: "1",
      uid: "3",
      hotkey: "z",
      coldkey: null,
      payload: null,
    },
    {
      kind: 0,
      netuid: "7",
      shard: "0",
      uid: null,
      hotkey: null,
      coldkey: null,
      payload: decoder.encode(
        '{"1":{"stake_tao":5,"validator_permit":true},"1":{"stake_tao":999},"01":{"stake_tao":888},"2":"not-json","4":null}',
      ) as Uint8Array | null,
    },
    ...["1", "2", "4", "5"].map((uid) => ({
      kind: 1,
      netuid: "7",
      shard: "0",
      uid,
      hotkey: uid === "2" ? null : "a",
      coldkey: "cold",
      payload: null,
    })),
  ];
  const read: ReadStoreDb = {
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (fail) throw new Error("native unavailable");
      return parts as Row[];
    },
    async first() {
      throw new Error("unexpected first");
    },
  };
  return {
    store: createPgNeuronViewStore({ read }, codec),
    calls,
    parts,
    fail() {
      fail = true;
    },
  };
}

test("view member paths keep first keys, missing fields and non-object values", async () => {
  const f = fixture();
  expect(await f.store.rows({ columns: ["uid", "stake_tao"] })).toEqual([
    { uid: 1, stake_tao: 5 },
    { uid: 2, stake_tao: null },
    { uid: 3, stake_tao: 2 },
    { uid: 4, stake_tao: null },
    { uid: 5, stake_tao: null },
  ]);
  expect(
    await f.store.rows({
      columns: ["uid"],
      validatorsOnly: true,
      order: [{ column: "stake_tao", descending: true }, { column: "uid" }],
      limit: 1,
    }),
  ).toEqual([{ uid: 1 }]);
  expect(
    await f.store.rows({
      columns: ["uid", "hotkey", "coldkey"],
      order: [{ column: "hotkey" }],
    }),
  ).toEqual([
    { uid: 2, hotkey: null, coldkey: "cold" },
    { uid: 1, hotkey: "a", coldkey: "cold" },
    { uid: 4, hotkey: "a", coldkey: "cold" },
    { uid: 5, hotkey: "a", coldkey: "cold" },
    { uid: 3, hotkey: "z", coldkey: null },
  ]);
  expect(f.calls[0].sql).toContain("selected AS MATERIALIZED");
});

test("view filters are typed and bind binary hotkey identity without NUL truncation", async () => {
  const f = fixture();
  await f.store.rows({
    columns: ["uid"],
    netuid: 7,
    uid: 1,
    hotkey: "a\0b",
    excludeRoot: true,
  });
  expect(f.calls[0].params).toEqual(["7", "1", Buffer.from("a\0b")]);
  expect(f.calls[0].sql).toContain("convert_to(m.hotkey,'UTF8')=$3::bytea");
  expect(f.calls[0].sql).toContain("m.netuid<>0");
  for (const query of [
    { columns: [] },
    { columns: ["uid", "uid"] },
    { columns: ["injected"] },
    { columns: ["uid"], order: [{ column: "injected" }] },
    { columns: ["uid"], order: [{ column: "uid" }, { column: "uid" }] },
    { columns: ["uid"], limit: 0 },
    { columns: ["uid"], limit: 1.5 },
    { columns: ["uid"], netuid: 1.5 },
    { columns: ["uid"], uid: Infinity },
    { columns: ["uid"], hotkey: 3 },
    { columns: ["uid"], validatorsOnly: 1 },
    { columns: ["uid"], excludeRoot: 1 },
    { columns: ["uid"], order: [{ column: "uid", descending: 1 }] },
  ])
    await expect(f.store.rows(query as NeuronViewQuery)).rejects.toThrow(
      "Invalid",
    );
  expect(await f.store.rows({ columns: ["uid"], uid: 1e30 })).toEqual([]);
  expect(await f.store.rows({ columns: ["uid"], netuid: -1e30 })).toEqual([]);
});

test("view ordering compares original values before D1 number conversion", async () => {
  const f = fixture();
  f.parts[2].payload = decoder.encode(
    '{"1":{"stake_tao":9007199254740993},"2":{"stake_tao":9007199254740992.0},"4":{"stake_tao":"a\\u0000z"},"5":{"stake_tao":"a\\u0000a"}}',
  );
  expect(
    await f.store.rows({
      columns: ["uid"],
      order: [{ column: "stake_tao", descending: true }],
    }),
  ).toEqual([{ uid: 4 }, { uid: 5 }, { uid: 1 }, { uid: 2 }, { uid: 3 }]);
  expect(await f.store.rows({ columns: ["uid"], order: [] })).toEqual([
    { uid: 1 },
    { uid: 2 },
    { uid: 3 },
    { uid: 4 },
    { uid: 5 },
  ]);
});

test("documents without accepted memberships do not invent view rows", async () => {
  const f = fixture();
  f.parts.splice(1, 1);
  expect(await f.store.rows({ columns: ["uid"] })).toEqual([
    { uid: 1 },
    { uid: 2 },
    { uid: 4 },
    { uid: 5 },
  ]);
});

test("raw codec member projections match SQL paths instead of json_each", () => {
  const payload = decoder.encode(
    '{"1":{"x":"a\\u0000b","n":9007199254740993},"1":{"x":"last"},"2":"malformed"}',
  );
  const rows = decoder.memberMetrics(payload, ["x", "n"], ["1", "2", "3"]);
  expect(rows.map(({ values }) => values)).toEqual([
    { x: "a\0b", n: 9007199254740993n },
    { x: null, n: null },
    { x: null, n: null },
  ]);
  expect([...(rows[0].textBytes?.x ?? [])]).toEqual([...Buffer.from("a\0b")]);
  expect(
    decoder.memberMetrics(decoder.encode('[{"x":5}]'), ["x"], ["0"])[0].values
      .x,
  ).toBeNull();
  expect(decoder.memberMetrics(payload, [], ["1"])).toEqual([
    { key: "1", values: {}, textBytes: {} },
  ]);
  for (const key of ["01", "-0", '1"', "1.0"])
    expect(() => decoder.memberMetrics(payload, ["x"], [key])).toThrow(
      "canonical",
    );
});

test("view capability rejects missing payload and scalar metadata", async () => {
  const f = fixture();
  f.parts[0].payload = null;
  await expect(f.store.rows({ columns: ["uid"] })).rejects.toThrow(
    "Missing native neuron view document",
  );
  for (const value of [new Uint8Array([1]), "missing bytes"]) {
    const bad = fixture({
      ...decoder,
      memberMetrics: () => [{ key: "3", values: { stake_tao: value } }],
    });
    await expect(bad.store.rows({ columns: ["stake_tao"] })).rejects.toThrow(
      value instanceof Uint8Array ? "BLOB" : "text bytes",
    );
  }
});

test("actual routes select native rows and keep failed selected reads opaque", async () => {
  const f = fixture(),
    env = { ...dataApiEnv(), NEURON_VIEW_STORE: f.store };
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const routes = [
    "subnets/7/neurons/1",
    "subnets/7/validators",
    "subnets/7/concentration",
    "subnets/7/performance",
    "subnets/7/idle-stake",
    "subnets/7/yield",
    "chain/concentration",
    "chain/idle-stake",
    "chain/yield",
    "accounts/a/subnets",
  ];
  for (const path of routes)
    expect(
      (
        await worker.fetch(
          new Request(`https://example.com/api/v1/${path}`),
          env,
          ctx,
        )
      ).status,
    ).toBe(200);
  const emptyEnv = {
    ...dataApiEnv(),
    NEURON_VIEW_STORE: {
      async rows() {
        return [];
      },
    },
  };
  const empty = await worker.fetch(
    new Request("https://example.com/api/v1/subnets/7/neurons/999"),
    emptyEnv,
    ctx,
  );
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({ netuid: 7, neuron: null });
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/v1/subnets/7/neurons"),
        env,
        ctx,
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/v1/subnets/7/neurons/1"),
        dataApiEnv(),
        ctx,
      )
    ).status,
  ).toBe(503);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  f.fail();
  try {
    for (const path of routes) {
      const response = await worker.fetch(
        new Request(`https://example.com/api/v1/${path}`),
        env,
        ctx,
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "data query failed" });
    }
  } finally {
    report.mockRestore();
  }
  for (const value of [null, undefined, 1, {}])
    expect(selectedNeuronViewStore(value)).toBeNull();
  for (const value of [null, undefined, {}, { rows: 1 }])
    expect(() => selectedNeuronViewStore({ NEURON_VIEW_STORE: value })).toThrow(
      "Invalid",
    );
});
