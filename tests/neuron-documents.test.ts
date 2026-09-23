import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import {
  neuronDocumentStatements,
  writeNeuronDocuments,
} from "../src/neuron-documents.ts";
import {
  mirrorNeuronSnapshotToNeon,
  neuronSnapshotWrite,
} from "../src/neurons-neon-write.ts";
import { NEURON_INSERT_COLUMNS } from "../src/metagraph-neurons.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = 1790090000000;
const owners = "neurons,neuron_daily,account_position_daily,neurons_passes";
const rows = (at = stamp): Record<string, unknown>[] => [
  {
    netuid: 1,
    uid: 0,
    hotkey: "5Apha",
    coldkey: "5Beta",
    captured_at: at,
    active: true,
    validator_permit: false,
    axon: '{"ip":42}',
    stake_tao: 0.000000001,
  },
  {
    netuid: 1,
    uid: 256,
    hotkey: "5Gamma",
    coldkey: null,
    captured_at: at,
    active: false,
    stake_tao: 123.25,
  },
];
const capture = (r: Record<string, unknown>[] = rows()) =>
  neuronSnapshotWrite(r, stamp + 500);
const empty = () => ({ rows: [], dailyRows: [], positionRows: [] });
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL("../migrations/d1/0007_neuron_documents.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => {
  await runtime.dispose();
});
beforeEach(async () => {
  for (const family of ["neurons", "neuron_daily", "account_position_daily"]) {
    await db.prepare(`DELETE FROM ${family}_members`).run();
    await db.prepare(`DELETE FROM ${family}_documents`).run();
  }
  await db.prepare("DELETE FROM neurons_passes").run();
});
const store = () => createD1Store(db);
const read = async (table = "neurons") =>
  (await db.prepare(`SELECT * FROM ${table} ORDER BY netuid,uid`).all())
    .results;
test("all columns and nulls survive native views; retries and newer captures do not rewrite stable membership", async () => {
  const input = capture();
  await writeNeuronDocuments(store(), input);
  const normalized = input.rows.map((row) =>
    Object.fromEntries(
      NEURON_INSERT_COLUMNS.map((c) => [
        c,
        typeof row[c] === "boolean" ? Number(row[c]) : (row[c] ?? null),
      ]),
    ),
  );
  assert.deepEqual(await read(), normalized);
  for (const family of ["neuron_daily", "account_position_daily"])
    assert.equal((await read(family)).length, 2);
  await db.prepare("CREATE TABLE touched_members(n INTEGER)").run();
  await db
    .prepare(
      "CREATE TRIGGER track_neuron_update AFTER UPDATE ON neurons_members BEGIN INSERT INTO touched_members VALUES(1); END",
    )
    .run();
  const retry = await db.batch(
    neuronDocumentStatements(input).map((s) =>
      db.prepare(s.text).bind(...(s.values ?? [])),
    ),
  );
  assert.equal(
    retry.reduce((sum, r) => sum + r.meta.changes, 0),
    0,
  );
  await writeNeuronDocuments(store(), capture(rows(stamp + 1000)));
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM touched_members").first("n"),
    0,
  );
  assert.equal((await read())[0].captured_at, stamp + 1000);
  await db.prepare("DROP TRIGGER track_neuron_update").run();
  await db.prepare("DROP TABLE touched_members").run();
});
test("partial, equal and older captures preserve per-member ordering and account history when a UID changes hotkey", async () => {
  await writeNeuronDocuments(store(), capture());
  const changed = {
    ...rows(stamp + 1000)[0],
    hotkey: "5Deta",
    coldkey: "5New",
    stake_tao: null,
  };
  await writeNeuronDocuments(store(), {
    ...capture([changed]),
    netuidMaxCapturedAt: null,
  });
  await writeNeuronDocuments(store(), {
    ...capture([{ ...changed, captured_at: stamp, hotkey: "5Stae" }]),
    netuidMaxCapturedAt: null,
  });
  await writeNeuronDocuments(store(), {
    ...capture([{ ...changed, hotkey: "5Equa" }]),
    netuidMaxCapturedAt: null,
  });
  const actual = await read();
  assert.equal(actual.length, 2);
  assert.equal(actual[0].hotkey, "5Deta");
  assert.equal(actual[0].stake_tao, null);
  assert.equal(actual[1].captured_at, stamp);
  assert.deepEqual(
    (
      await db
        .prepare("SELECT account FROM account_position_daily ORDER BY account")
        .all()
    ).results.map((r) => r.account),
    ["5Apha", "5Deta", "5Equa", "5Gamma", "5Stae"],
  );
  // A delayed previously unseen member belongs in the same daily partition.
  await writeNeuronDocuments(store(), {
    ...capture([{ ...rows()[0], uid: 2, hotkey: "5Late" }]),
    rows: [],
    netuidMaxCapturedAt: null,
  });
  assert.equal((await read("neuron_daily")).length, 3);
  assert.equal((await read()).length, 2);
});
test("pruning is per-netuid, preserves newer captures, and never prunes either daily family", async () => {
  await writeNeuronDocuments(
    store(),
    capture([
      ...rows(),
      { ...rows()[0], netuid: 2, captured_at: stamp + 2000 },
    ]),
  );
  await writeNeuronDocuments(
    store(),
    capture([{ ...rows()[0], captured_at: stamp + 1000 }]),
  );
  assert.deepEqual(
    (await read()).map((r) => [r.netuid, r.uid, r.captured_at]),
    [
      [1, 0, stamp + 1000],
      [2, 0, stamp + 2000],
    ],
  );
  assert.equal((await read("neuron_daily")).length, 3);
  assert.equal((await read("account_position_daily")).length, 3);
  // An older prune cannot remove the future row, even without incoming rows.
  await writeNeuronDocuments(store(), {
    ...empty(),
    netuidMaxCapturedAt: new Map([[2, stamp]]),
  });
  assert.equal((await read()).length, 2);
});
test("pass receipts and every table roll back when the final statement fails", async () => {
  await writeNeuronDocuments(store(), capture());
  await db
    .prepare(
      "CREATE TRIGGER reject_pass BEFORE INSERT ON neurons_passes BEGIN SELECT RAISE(ABORT,'injected final failure'); END",
    )
    .run();
  const pass = {
    capturedAt: stamp + 1000,
    expectedRows: 2,
    receivedRows: 2,
    nowMs: stamp + 2000,
  };
  await assert.rejects(
    writeNeuronDocuments(store(), { ...capture(rows(stamp + 1000)), pass }),
    /injected final failure/,
  );
  assert.equal((await read())[0].captured_at, stamp);
  assert.equal((await read("neuron_daily"))[0].captured_at, stamp);
  await db.prepare("DROP TRIGGER reject_pass").run();
  await writeNeuronDocuments(store(), {
    ...capture(rows(stamp + 1000)),
    pass: { ...pass, receivedRows: 1 },
  });
  assert.equal(
    await db
      .prepare("SELECT completed_at FROM neurons_passes")
      .first("completed_at"),
    null,
  );
  await writeNeuronDocuments(store(), {
    ...empty(),
    pass: { ...pass, receivedRows: 1 },
  });
  assert.equal(
    await db
      .prepare("SELECT completed_at FROM neurons_passes")
      .first("completed_at"),
    stamp + 2000,
  );
  await writeNeuronDocuments(store(), {
    ...empty(),
    pass: { ...pass, nowMs: stamp + 4000 },
  });
  assert.equal(
    await db
      .prepare("SELECT completed_at FROM neurons_passes")
      .first("completed_at"),
    stamp + 2000,
  );
});
test("selected ownership writes directly without Hyperdrive or the Neon buffer, and reports transaction failures", async () => {
  const env = { D1_STATE: db, D1_STATE_TABLES: owners };
  const lanes: unknown[] = [];
  const laneHealthDb = {
    async query<Row>(): Promise<Row[]> {
      return [];
    },
    async run(_sql: string, values: unknown[] = []) {
      lanes.push(values[0]);
      return { changes: 1 };
    },
  };
  const first = await mirrorNeuronSnapshotToNeon(env, null, capture(), {
    now: () => stamp,
    laneHealthDb,
  });
  assert.equal(first.prune?.ok, true);
  assert.ok(lanes.includes("neon:neurons-prune"));
  assert.ok(Object.values(first.results).every((r) => r.ok));
  const pass = {
    capturedAt: stamp,
    expectedRows: 2,
    receivedRows: 2,
    nowMs: stamp,
  };
  assert.equal(
    (await mirrorNeuronSnapshotToNeon(env, null, { ...empty(), pass })).results
      .neurons_passes.ok,
    true,
  );
  await db
    .prepare(
      "CREATE TRIGGER fail_neurons BEFORE UPDATE ON neurons_documents BEGIN SELECT RAISE(ABORT,'injected write failure'); END",
    )
    .run();
  const failed = await mirrorNeuronSnapshotToNeon(env, null, {
    ...capture(rows(stamp + 1)),
    pass,
  });
  assert.ok(Object.values(failed.results).every((r) => !r.ok));
  assert.equal(failed.results.neurons_passes.rows, 0);
  await db.prepare("DROP TRIGGER fail_neurons").run();
});
test("invalid and oversized data fail before any transaction executes; empty captures are harmless", async () => {
  assert.deepEqual(neuronDocumentStatements(empty()), []);
  const invalid = [
    { netuid: -1 },
    { captured_at: 42 },
    { uid: -1 },
    { stake_tao: Infinity },
    { axon: {} },
    { hotkey: undefined, uid: NaN },
  ];
  for (const patch of invalid)
    assert.throws(() =>
      neuronDocumentStatements(capture([{ ...rows()[0], ...patch }])),
    );
  assert.throws(
    () =>
      neuronDocumentStatements({
        ...empty(),
        positionRows: [{ ...capture().positionRows[0], account: 42 }],
      }),
    /member key/,
  );
  assert.throws(
    () =>
      neuronDocumentStatements({
        ...empty(),
        dailyRows: [{ ...capture().dailyRows[0], snapshot_date: null }],
      }),
    /snapshot day/,
  );
  assert.throws(
    () =>
      neuronDocumentStatements({
        ...empty(),
        dailyRows: [{ ...capture().dailyRows[0], snapshot_date: "no" }],
      }),
    /snapshot day/,
  );
  assert.throws(
    () => neuronDocumentStatements(capture([rows()[0], rows()[0]])),
    /Duplicate/,
  );
  assert.throws(
    () =>
      neuronDocumentStatements(
        capture([{ ...rows()[0], axon: "x".repeat(524288) }]),
      ),
    /512 KiB/,
  );
  assert.throws(
    () =>
      neuronDocumentStatements({
        ...empty(),
        netuidMaxCapturedAt: new Map([[1, 42]]),
      }),
    /cutoff/,
  );
});

test("partitioned captures retain quoted account keys, multiple days and every native column", async () => {
  const source = [
    { ...rows()[0], hotkey: 'quoted"key.☃', coldkey: "first" },
    { ...rows()[0], uid: 2, hotkey: "__proto__", coldkey: "second" },
  ];
  await writeNeuronDocuments(store(), capture(source));
  const expected = capture(source).positionRows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        typeof v === "boolean" ? Number(v) : (v ?? null),
      ]),
    ),
  );
  const actual = (
    await db.prepare("SELECT * FROM account_position_daily ORDER BY uid").all()
  ).results;
  assert.deepEqual(actual, expected);
  const tomorrow = capture(
    source.map((r) => ({ ...r, captured_at: stamp + 86400000 })),
  );
  await writeNeuronDocuments(store(), tomorrow);
  assert.equal((await read("neuron_daily")).length, 4);
  assert.equal((await read("account_position_daily")).length, 4);
});
test("large captures split SQL payloads but remain one atomic database transaction", async () => {
  const source = Array.from({ length: 10 }, (_, netuid) => ({
    ...rows()[0],
    netuid,
    axon: "x".repeat(100000),
  }));
  const input = { ...capture(source), dailyRows: [], positionRows: [] };
  const statements = neuronDocumentStatements(input);
  assert.ok(statements.length > 4);
  await writeNeuronDocuments(store(), input);
  assert.equal((await read()).length, 10);
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM neurons_documents")
    .first("n");
  assert.equal(count, 10);
  // A merge can exceed the retained document limit even when each request fits.
  const many = Array.from({ length: 8 }, (_, uid) => ({
    ...rows()[0],
    netuid: 20,
    uid,
    axon: "x".repeat(60000),
  }));
  await writeNeuronDocuments(store(), { ...empty(), rows: many });
  await assert.rejects(
    writeNeuronDocuments(store(), {
      ...empty(),
      rows: [{ ...many[0], uid: 9 }],
    }),
    /constraint/,
  );
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM neurons WHERE netuid=20")
      .first("n"),
    8,
  );
});

test("an oversized atomic capture is refused before submitting a database transaction", async () => {
  const axon = "x".repeat(300000);
  const source = Array.from({ length: 451 }, (_, netuid) => ({
    ...rows()[0],
    netuid,
    axon,
  }));
  let submitted = false;
  await assert.rejects(
    writeNeuronDocuments(
      {
        ...store(),
        async transaction() {
          submitted = true;
          return [];
        },
      },
      { ...empty(), rows: source },
    ),
    /atomic statement budget/,
  );
  assert.equal(submitted, false);
  assert.equal((await read()).length, 0);
});

test("pruning materializes stale document keys once instead of correlating every member", async () => {
  const input = capture();
  await writeNeuronDocuments(store(), input);
  const statements = neuronDocumentStatements({
    ...empty(),
    netuidMaxCapturedAt: new Map([[1, stamp + 1]]),
  });
  const statement = statements.find((s) =>
    s.text.startsWith("DELETE FROM neurons_members"),
  )!;
  const plan = (
    await db
      .prepare("EXPLAIN QUERY PLAN " + statement.text)
      .bind(...(statement.values ?? []))
      .all<{ detail: string }>()
  ).results.map((r) => r.detail);
  assert.ok(plan.some((s) => s.includes("SCAN i VIRTUAL TABLE")));
  assert.ok(
    plan.every((s) => !s.includes("CORRELATED")),
    plan.join("\n"),
  );
  await store().transaction(statements);
  assert.deepEqual(await read(), []);
});

test("mixed timestamps cannot take the whole-document newer fast path", async () => {
  const base = Array.from({ length: 256 }, (_, uid) => ({
    ...rows()[0],
    uid,
    hotkey: `5Key${uid}`,
    captured_at: stamp + (uid === 0 ? 5000 : 0),
  }));
  await writeNeuronDocuments(store(), { ...empty(), rows: base });
  const incoming = [
    { ...base[0], hotkey: "5Stale", captured_at: stamp + 1000 },
    { ...base[1], hotkey: "5Newer", captured_at: stamp + 6000 },
    { ...base[2], hotkey: "5Middle", captured_at: stamp + 1000 },
  ];
  await writeNeuronDocuments(store(), { ...empty(), rows: incoming });
  let actual = await read();
  assert.equal(actual.length, 256);
  assert.deepEqual(
    actual.slice(0, 3).map((r) => [r.hotkey, r.captured_at]),
    [
      ["5Key0", stamp + 5000],
      ["5Newer", stamp + 6000],
      ["5Middle", stamp + 1000],
    ],
  );
  // Every incoming timestamp now exceeds the retained maximum. Sparse updates
  // must retain untouched members, null values, and their accepted identities.
  await writeNeuronDocuments(store(), {
    ...empty(),
    rows: [
      {
        ...base[0],
        captured_at: stamp + 7000,
        hotkey: "5Fresh",
        stake_tao: null,
      },
      { ...base[2], captured_at: stamp + 8000, hotkey: null },
    ],
  });
  actual = await read();
  assert.equal(actual.length, 256);
  assert.equal(actual[0].hotkey, "5Fresh");
  assert.equal(actual[0].stake_tao, null);
  assert.equal(actual[1].hotkey, "5Newer");
  assert.equal(actual[2].hotkey, null);
  assert.equal(actual[3].captured_at, stamp);
});
