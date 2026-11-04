import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createPgChainConcentrationStore } from "../src/pg-chain-concentration.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import {
  selectedChainConcentrationStore,
  type ChainConcentrationRecord,
  type ChainConcentrationStore,
} from "../src/chain-concentration-store.ts";
import { rollupChainConcentration } from "../src/chain-concentration-rollup.ts";
import { buildChainConcentration } from "../src/concentration.ts";
import { handleScheduled } from "../workers/api.ts";
import { CHAIN_CONCENTRATION_ROLLUP_CRON } from "../workers/config.ts";

const now = Date.UTC(2026, 10, 4);
const rows = [
  {
    stake_tao: 4,
    emission_tao: 2,
    validator_permit: 1,
    captured_at: now - 1,
    coldkey: "coldkey",
    netuid: 7,
  },
];
function fixture() {
  const records: ChainConcentrationRecord[] = [];
  const native: ChainConcentrationStore = {
    async pendingDays(beforeDay, limit) {
      assert.equal(beforeDay, "2026-11-04");
      assert.equal(limit, 3);
      return ["2026-11-03"];
    },
    async dailyRows(day) {
      assert.equal(day, "2026-11-03");
      return rows;
    },
    async put(record) {
      records.push(record);
    },
  };
  return { native, records };
}

test("the native selector requires the complete explicit capability", () => {
  for (const env of [null, undefined, false, 1, "", {}])
    assert.equal(selectedChainConcentrationStore(env), null);
  const { native } = fixture();
  assert.equal(
    selectedChainConcentrationStore({ CHAIN_CONCENTRATION_STORE: native }),
    native,
  );
  for (const value of [
    null,
    false,
    {},
    { ...native, put: undefined },
    { ...native, pendingDays: 1 },
    { ...native, dailyRows: "rows" },
  ])
    assert.throws(
      () =>
        selectedChainConcentrationStore({ CHAIN_CONCENTRATION_STORE: value }),
      /incomplete/,
    );
});

test("native rollup retains the existing builder and exact stored card fields", async () => {
  const { native, records } = fixture();
  const result = await rollupChainConcentration(null, { nowMs: now, native });
  assert.deepEqual(result, {
    rolled: true,
    days_rolled: ["2026-11-03"],
    days_failed: [],
    days_pending: 1,
  });
  const card = buildChainConcentration(rows);
  assert.deepEqual(records, [
    {
      day: "2026-11-03",
      neuronCount: 1,
      card: JSON.stringify(card),
      capturedAt: now - 1,
      computedAt: now,
      builderVersion: card.schema_version,
    },
  ]);
});

test("the real scheduled handler selects the dedicated source before the generic writer", async () => {
  const { native, records } = fixture();
  const time = vi.spyOn(Date, "now").mockReturnValue(now);
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil(task: Promise<unknown>) {
      pending.push(task);
    },
  };
  try {
    const env = {
      CHAIN_CONCENTRATION_STORE: native,
      NATIVE_PRODUCER_STORE: {},
    } as unknown as Env;
    const result = await handleScheduled(
      { cron: CHAIN_CONCENTRATION_ROLLUP_CRON, scheduledTime: now },
      env,
      context,
    );
    assert.equal((result as Record<string, unknown>).rolled, true);
    assert.equal(records.length, 1);
    await assert.rejects(
      handleScheduled(
        { cron: CHAIN_CONCENTRATION_ROLLUP_CRON, scheduledTime: now },
        { NATIVE_PRODUCER_STORE: {} } as Env,
        context,
      ),
      /native producer/i,
    );
    await assert.rejects(
      handleScheduled(
        { cron: CHAIN_CONCENTRATION_ROLLUP_CRON, scheduledTime: now },
        { CHAIN_CONCENTRATION_STORE: null } as unknown as Env,
        context,
      ),
      /incomplete/,
    );
    await Promise.all(pending);
  } finally {
    time.mockRestore();
  }
});

test("native scan and per-day failures never access an alternate database", async () => {
  const legacy = {
    async query() {
      throw new Error("legacy called");
    },
    async run() {
      throw new Error("legacy called");
    },
  };
  const { native, records } = fixture();
  native.pendingDays = async () => {
    throw new Error("native unavailable");
  };
  assert.deepEqual(
    await rollupChainConcentration(legacy, { nowMs: now, native }),
    { rolled: false, reason: "scan_failed" },
  );
  native.pendingDays = async () => ["scan", "empty", "write", "good"];
  native.dailyRows = async (day) => {
    if (day === "scan") throw new Error("read unavailable");
    return day === "empty" ? [] : rows;
  };
  native.put = async (record) => {
    if (record.day === "write") throw new Error("write unavailable");
    records.push(record);
  };
  assert.deepEqual(
    await rollupChainConcentration(legacy, { nowMs: now, native }),
    {
      rolled: true,
      days_rolled: ["good"],
      days_failed: ["scan", "empty", "write"],
      days_pending: 4,
    },
  );
  assert.equal(records.length, 1);
});

test("PostgreSQL document reads preserve duplicate integer aliases and accepted member identity", async () => {
  const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 });
  try {
    const payload = decoder.encode(
      '{"01":{"stake_tao":1,"captured_at":9007199254740993},"1":{"stake_tao":2},"1":{"stake_tao":3},"9":"not-json","0":null}',
    );
    const statements: { text: string; values?: unknown[] }[] = [];
    const parts = [
      {
        kind: 1,
        netuid: "2",
        shard: "4",
        uid: "1",
        coldkey: "accepted",
        payload: null,
      },
      { kind: 0, netuid: "2", shard: "4", uid: null, coldkey: null, payload },
      {
        kind: 0,
        netuid: "1",
        shard: "0",
        uid: null,
        coldkey: null,
        payload: null,
      },
      {
        kind: 1,
        netuid: "2",
        shard: "4",
        uid: "0",
        coldkey: null,
        payload: null,
      },
    ];
    const store = createPgChainConcentrationStore(
      {
        read: {
          async query<T>(text: string, values?: unknown[]) {
            statements.push({ text, values });
            return parts as unknown as T[];
          },
          async first() {
            return null;
          },
        },
        producer: {
          async query() {
            return [];
          },
          async first() {
            return null;
          },
          async run() {
            return { changes: 1 };
          },
          async transaction() {
            return [];
          },
        },
      },
      decoder,
    );
    assert.deepEqual(await store.dailyRows("2026-11-03"), [
      {
        stake_tao: 1,
        emission_tao: null,
        validator_permit: null,
        captured_at: 9007199254740992,
        coldkey: "accepted",
        netuid: 2,
      },
      {
        stake_tao: 2,
        emission_tao: null,
        validator_permit: null,
        captured_at: null,
        coldkey: "accepted",
        netuid: 2,
      },
      {
        stake_tao: 3,
        emission_tao: null,
        validator_permit: null,
        captured_at: null,
        coldkey: "accepted",
        netuid: 2,
      },
      {
        stake_tao: null,
        emission_tao: null,
        validator_permit: null,
        captured_at: null,
        coldkey: null,
        netuid: 2,
      },
    ]);
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0]!.values, ["2026-11-03"]);
    assert(statements[0]!.text.includes("UNION ALL"));
  } finally {
    decoder.close();
  }
});

test("native pending days and counted writes use the same source without silent write success", async () => {
  const queries: { text: string; values?: unknown[] }[] = [];
  let changes = 1;
  const store = createPgChainConcentrationStore(
    {
      read: {
        async query<T>(text: string, values?: unknown[]) {
          queries.push({ text, values });
          return [{ day: "2026-11-03" }] as T[];
        },
        async first() {
          return null;
        },
      },
      producer: {
        async query() {
          return [];
        },
        async first() {
          return null;
        },
        async transaction() {
          return [];
        },
        async run(text, values) {
          queries.push({ text, values });
          return { changes };
        },
      },
    },
    {
      metricEntries() {
        return [];
      },
    },
  );
  assert.deepEqual(await store.pendingDays("2026-11-04", 3), ["2026-11-03"]);
  assert.deepEqual(queries[0]!.values, ["2026-11-04", 3]);
  const record = {
    day: "2026-11-03",
    neuronCount: 1,
    card: '{"x":1}',
    capturedAt: null,
    computedAt: now,
    builderVersion: 1,
  };
  await store.put(record);
  assert.deepEqual(queries[1]!.values, [
    record.day,
    1,
    record.card,
    null,
    now,
    1,
  ]);
  changes = 0;
  await assert.rejects(store.put(record), /not committed/);
});

test("document order is numeric by subnet then shard before floating-point folding", async () => {
  const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 });
  try {
    const order = [
      [2, 3],
      [1, 1],
      [2, 1],
      [1, 5],
    ];
    const parts = order.flatMap(([netuid, shard]) => [
      {
        kind: 0,
        netuid: String(netuid),
        shard: String(shard),
        uid: null,
        coldkey: null,
        payload: decoder.encode(
          JSON.stringify({ [shard!]: { stake_tao: netuid! * 10 + shard! } }),
        ),
      },
      {
        kind: 1,
        netuid: String(netuid),
        shard: String(shard),
        uid: String(shard),
        coldkey: "entity",
        payload: null,
      },
    ]);
    const store = createPgChainConcentrationStore(
      {
        read: {
          async query<T>() {
            return parts as unknown as T[];
          },
          async first() {
            return null;
          },
        },
        producer: {
          async query() {
            return [];
          },
          async first() {
            return null;
          },
          async run() {
            return { changes: 1 };
          },
          async transaction() {
            return [];
          },
        },
      },
      decoder,
    );
    assert.deepEqual(
      (await store.dailyRows("2026-11-03")).map((row) => row.stake_tao),
      [11, 15, 21, 23],
    );
  } finally {
    decoder.close();
  }
});

test("missing native documents and inconsistent decoder membership fail visibly", async () => {
  let parts: Record<string, unknown>[] = [];
  const runtime = {
    read: {
      async query<T>() {
        return parts as T[];
      },
      async first() {
        return null;
      },
    },
    producer: {
      async query() {
        return [];
      },
      async first() {
        return null;
      },
      async run() {
        return { changes: 1 };
      },
      async transaction() {
        return [];
      },
    },
  };
  const document = {
    kind: 0,
    netuid: "1",
    shard: "0",
    uid: null,
    coldkey: null,
    payload: null,
  };
  const member = {
    kind: 1,
    netuid: "1",
    shard: "0",
    uid: "1",
    coldkey: null,
    payload: null,
  };
  const decoder = {
    metricEntries() {
      return [{ key: "1", values: {} }];
    },
  };
  const store = createPgChainConcentrationStore(runtime, decoder);
  parts = [document, member];
  await assert.rejects(
    store.dailyRows("2026-11-03"),
    /Missing native concentration document/,
  );
  parts = [{ ...document, payload: new Uint8Array([1]) }, member];
  await assert.rejects(
    store.dailyRows("2026-11-03"),
    /Missing concentration integer key/,
  );
  const unmatched = createPgChainConcentrationStore(runtime, {
    metricEntries() {
      return [{ key: "2", integerKey: 2n, values: {} }];
    },
  });
  await assert.rejects(
    unmatched.dailyRows("2026-11-03"),
    /Unmatched concentration member/,
  );
});
