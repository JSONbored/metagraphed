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
import {
  NEURONS_COVERAGE_SQL,
  NEURONS_D1_COVERAGE_SQL,
  evaluateNeuronsStaleness,
  runNeuronsStalenessWatchdog,
} from "../src/neurons-staleness-watchdog.ts";
import {
  crossCheckSql,
  crossCheckStamps,
  confirmRedirectedStale,
  TABLE_FRESHNESS,
  freshnessTables,
} from "../src/table-freshness-watchdog.ts";
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
  for (const file of [
    "0007_neuron_documents.sql",
    "0020_neuron_axon_projection.sql",
    "0030_neuron_axon_insert_projection.sql",
    "0031_neuron_axon_document_projection.sql",
  ]) {
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  }
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
test("sparse mixed-age captures index only their accepted members within a populated shard", async () => {
  const initial = Array.from({ length: 8 }, (_, uid) => ({
    ...rows()[0],
    uid,
    hotkey: `hotkey-${uid}`,
    coldkey: `coldkey-${uid}`,
  }));
  await writeNeuronDocuments(store(), capture(initial));
  await db.prepare("CREATE TABLE attempted_daily_members(uid INTEGER)").run();
  await db
    .prepare(
      "CREATE TRIGGER track_daily_insert BEFORE INSERT ON neuron_daily_members BEGIN INSERT INTO attempted_daily_members VALUES(NEW.uid); END",
    )
    .run();
  try {
    await writeNeuronDocuments(store(), {
      ...capture([
        { ...initial[2], captured_at: stamp + 1000, hotkey: "new-owner" },
        { ...initial[5], captured_at: stamp - 1000, hotkey: "stale-owner" },
      ]),
      netuidMaxCapturedAt: null,
    });
    assert.deepEqual(
      (
        await db
          .prepare("SELECT uid FROM attempted_daily_members ORDER BY uid")
          .all()
      ).results,
      [{ uid: 2 }, { uid: 5 }],
    );
    const daily = await read("neuron_daily");
    assert.equal(daily.length, initial.length);
    assert.equal(daily[2].hotkey, "new-owner");
    assert.equal(daily[2].captured_at, stamp + 1000);
    assert.equal(daily[5].hotkey, "hotkey-5");
    assert.equal(daily[5].captured_at, stamp);
    for (const uid of [0, 1, 3, 4, 6, 7]) {
      assert.equal(daily[uid].hotkey, initial[uid].hotkey);
      assert.equal(daily[uid].captured_at, stamp);
    }
  } finally {
    await db.prepare("DROP TRIGGER track_daily_insert").run();
    await db.prepare("DROP TABLE attempted_daily_members").run();
  }
});
test("full-shard membership updates send only keys and preserve accepted identities in every family", async () => {
  const initial = Array.from({ length: 256 }, (_, uid) => ({
    ...rows()[0],
    uid,
    hotkey: `key-${uid}`,
    coldkey: `owner-${uid}`,
    axon: "x".repeat(512),
  }));
  const input = capture(initial);
  const statements = neuronDocumentStatements(input);
  for (const family of ["neurons", "neuron_daily", "account_position_daily"]) {
    const documents = statements.find((s) =>
      s.text.startsWith(`INSERT INTO ${family}_documents`),
    )!;
    const members = statements.find((s) =>
      s.text.includes(`INSERT INTO ${family}_members`),
    )!;
    const payload = String(members.values![0]);
    assert.ok(payload.length < String(documents.values![0]).length / 10);
    assert.ok(!payload.includes("captured_at") && !payload.includes("axon"));
    const plan = (
      await db
        .prepare("EXPLAIN QUERY PLAN " + members.text)
        .bind(...(members.values ?? []))
        .all<{ detail: string }>()
    ).results.map((r) => r.detail);
    assert.ok(plan.some((step) => step.includes("MATERIALIZE incoming")));
    assert.ok(
      plan.every((step) => !step.includes("CORRELATED")),
      plan.join("\n"),
    );
  }
  await writeNeuronDocuments(store(), input);
  const update = initial.map((row) => ({
    ...row,
    captured_at: stamp + 1000,
    stake_tao: 42,
  }));
  await writeNeuronDocuments(store(), capture(update));
  for (const family of ["neurons", "neuron_daily", "account_position_daily"]) {
    const actual = await read(family);
    assert.equal(actual.length, 256);
    assert.ok(actual.every((row) => row.captured_at === stamp + 1000));
    assert.ok(
      actual.every(
        (row) =>
          row.hotkey === `key-${row.uid}` || row.account === `key-${row.uid}`,
      ),
    );
  }
});
test("account membership preserves stale retries and partition identity without reading metric documents", async () => {
  const account = 'quoted"\\account-\u00e9';
  const position = (
    name: string,
    at = stamp,
    netuid = 1,
    snapshot_date = "2026-09-22",
  ) => ({
    account: name,
    netuid,
    snapshot_date,
    captured_at: at,
    stake_tao: at === stamp ? 42 : 1,
  });
  const input = {
    ...empty(),
    positionRows: [position(account), position("unchanged")],
  };
  await writeNeuronDocuments(store(), input);
  // Repair a missing index row using an older capture, retaining newer metrics.
  await db
    .prepare("DELETE FROM account_position_daily_members WHERE account=?")
    .bind(account)
    .run();
  const retry = {
    ...empty(),
    positionRows: [
      position(account, stamp - 1000),
      position("late", stamp - 1000),
      position(account, stamp, 2),
      position(account, stamp, 1, "2026-09-23"),
    ],
  };
  const membership = neuronDocumentStatements(retry).find((s) =>
    s.text.includes("INSERT INTO account_position_daily_members"),
  )!;
  const plan = (
    await db
      .prepare("EXPLAIN QUERY PLAN " + membership.text)
      .bind(...membership.values!)
      .all<{ detail: string }>()
  ).results
    .map((r) => r.detail)
    .join("\n");
  assert.match(plan, /MATERIALIZE incoming/);
  assert.doesNotMatch(plan, /account_position_daily_documents|CORRELATED/);
  await writeNeuronDocuments(store(), retry);
  const actual = (
    await db
      .prepare(
        "SELECT account,netuid,snapshot_date,captured_at,stake_tao FROM account_position_daily ORDER BY account,netuid,snapshot_date",
      )
      .all()
  ).results;
  const expected = [
    position("late", stamp - 1000),
    position(account),
    position(account, stamp, 1, "2026-09-23"),
    position(account, stamp, 2),
    position("unchanged"),
  ];
  assert.deepEqual(actual, expected);
  const repeated = await db.batch(
    neuronDocumentStatements(retry).map((s) =>
      db.prepare(s.text).bind(...(s.values ?? [])),
    ),
  );
  assert.equal(
    repeated.reduce((sum, r) => sum + r.meta.changes, 0),
    0,
  );
});
test("new daily membership indexes axons once and retains legacy writer recovery", async () => {
  const initial = Array.from({ length: 256 }, (_, uid) => ({
    ...rows()[0],
    uid,
    hotkey: `hotkey-${uid}`,
    coldkey: `coldkey-${uid}`,
    axon: uid % 2 ? null : "1.2.3.4:8091",
  }));
  const input = capture(initial);
  await db.prepare("CREATE TABLE axon_rewrites(uid INTEGER)").run();
  await db
    .prepare(
      "CREATE TRIGGER count_axon_rewrites AFTER UPDATE OF axon_index ON neuron_daily_members BEGIN INSERT INTO axon_rewrites VALUES(NEW.uid); END",
    )
    .run();
  const projection = async () =>
    (
      await db
        .prepare(
          "SELECT m.uid,m.axon_index,m.axon_indexed,json_extract(d.payload,'$.\"'||m.uid||'\".axon') AS canonical FROM neuron_daily_members m JOIN neuron_daily_documents d ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard ORDER BY m.uid",
        )
        .all()
    ).results;
  try {
    // Compare actual old/new triggers over the same accepted capture. Timing
    // is reported for qualification, not used as a flaky pass/fail threshold.
    await db.prepare("DROP TRIGGER neuron_daily_axon_member_insert").run();
    const original = readFileSync(
      new URL(
        "../migrations/d1/0020_neuron_axon_projection.sql",
        import.meta.url,
      ),
      "utf8",
    )
      .split("-- statement-breakpoint")
      .find((sql) =>
        sql.includes("CREATE TRIGGER neuron_daily_axon_member_insert"),
      )!;
    await db.prepare(original).run();
    const before = await db.batch(
      neuronDocumentStatements(input).map((s) =>
        db.prepare(s.text).bind(...(s.values ?? [])),
      ),
    );
    const expected = await projection();
    assert.equal(
      await db.prepare("SELECT COUNT(*) AS n FROM axon_rewrites").first("n"),
      256,
    );
    for (const family of [
      "neurons",
      "neuron_daily",
      "account_position_daily",
    ]) {
      await db.prepare(`DELETE FROM ${family}_members`).run();
      await db.prepare(`DELETE FROM ${family}_documents`).run();
    }
    await db.prepare("DELETE FROM neurons_passes").run();
    await db.prepare("DELETE FROM axon_rewrites").run();
    for (const sql of readFileSync(
      new URL(
        "../migrations/d1/0030_neuron_axon_insert_projection.sql",
        import.meta.url,
      ),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
    const after = await db.batch(
      neuronDocumentStatements(input).map((s) =>
        db.prepare(s.text).bind(...(s.values ?? [])),
      ),
    );
    assert.deepEqual(await projection(), expected);
    assert.ok(
      expected.every(
        (row) => row.axon_indexed === 1 && row.axon_index === row.canonical,
      ),
    );
    assert.equal(
      await db.prepare("SELECT COUNT(*) AS n FROM axon_rewrites").first("n"),
      0,
    );
    const measured = (results: D1Result[]) => ({
      duration: results.reduce((sum, r) => sum + r.meta.duration, 0),
      writes: results.reduce((sum, r) => sum + r.meta.rows_written, 0),
    });
    assert.ok(measured(after).writes < measured(before).writes);
    console.log("daily-membership qualification", {
      before: measured(before),
      after: measured(after),
    });
    // A legacy writer that omits the projection still receives the canonical
    // value, even if it replaces an already indexed member.
    await db.prepare("DELETE FROM neuron_daily_members WHERE uid=0").run();
    await db
      .prepare(
        "INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,hotkey,coldkey,shard) SELECT netuid,0,day,'hotkey-0','coldkey-0',shard FROM neuron_daily_documents WHERE shard=0",
      )
      .run();
    assert.deepEqual(await projection(), expected);
    assert.equal(
      await db.prepare("SELECT COUNT(*) AS n FROM axon_rewrites").first("n"),
      1,
    );
    // A newer correction refreshes the derived field; a late older capture
    // cannot regress either the document or its projected axon.
    await writeNeuronDocuments(
      store(),
      capture(
        initial.map((row) => ({
          ...row,
          captured_at: stamp + 1000,
          axon: "8.8.8.8:8091",
        })),
      ),
    );
    await writeNeuronDocuments(store(), capture(initial));
    assert.ok(
      (await projection()).every(
        (row) =>
          row.axon_index === "8.8.8.8:8091" && row.axon_index === row.canonical,
      ),
    );
  } finally {
    await db.prepare("DROP TRIGGER count_axon_rewrites").run();
    await db.prepare("DROP TABLE axon_rewrites").run();
  }
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

test("D1 freshness stamps equal actual views across mixed, delayed and pruned captures", async () => {
  const env = { D1_STATE: db, D1_STATE_TABLES: owners };
  const families = ["neurons", "neuron_daily", "account_position_daily"];
  const spec = Object.fromEntries(families.map((t) => [t, TABLE_FRESHNESS[t]]));
  const compare = async () => {
    const native = crossCheckSql(spec, env);
    assert.ok(native.includes("_documents"));
    assert.ok(!native.includes("json_extract"));
    assert.deepEqual(
      (await db.prepare(native).all()).results,
      (await db.prepare(crossCheckSql(spec)).all()).results,
    );
  };
  await compare();
  await writeNeuronDocuments(store(), {
    ...capture([
      { ...rows()[0], captured_at: stamp + 10 },
      { ...rows()[1], captured_at: stamp + 20 },
    ]),
    netuidMaxCapturedAt: undefined,
  });
  await compare();
  await writeNeuronDocuments(store(), capture(rows(stamp + 5)));
  await compare();
  await writeNeuronDocuments(store(), capture(rows(stamp + 30)));
  await compare();
  await writeNeuronDocuments(store(), {
    ...empty(),
    netuidMaxCapturedAt: new Map([[1, stamp + 31]]),
  });
  await compare();
  // Empty newer documents must not hide the older rows that remain elsewhere.
  await writeNeuronDocuments(
    store(),
    capture([{ ...rows()[0], netuid: 2, captured_at: stamp + 4 }]),
  );
  await compare();
  await db
    .prepare("INSERT INTO neurons_passes VALUES (?,1,1,?)")
    .bind(stamp + 30, stamp + 30)
    .run();
  const checked = await crossCheckStamps(env, {}, spec);
  assert.deepEqual(checked, {
    failed: false,
    divergences: [
      {
        table: "neurons",
        stampFrom: "neurons_passes",
        cheap: stamp + 30,
        actual: stamp + 4,
      },
    ],
  });
  assert.equal(freshnessTables().includes("schema_migrations"), false);
});

test("D1 confirms an old pass against fresh documents and fails closed without the selected binding", async () => {
  const env = { D1_STATE: db, D1_STATE_TABLES: owners };
  const spec = { neurons: { ...TABLE_FRESHNESS.neurons, maxAgeMs: 500 } };
  await writeNeuronDocuments(store(), capture(rows(stamp + 900)));
  const stale = [
    { table: "neurons", ageMs: 1000, maxAgeMs: 500, reason: "fixture" },
  ];
  assert.deepEqual(
    await confirmRedirectedStale(stale, env, {}, () => stamp + 1000, spec),
    [],
  );
  const unbound = { D1_STATE_TABLES: owners };
  assert.deepEqual(await crossCheckStamps(unbound, {}, spec), {
    divergences: [],
    failed: true,
  });
  assert.deepEqual(
    await confirmRedirectedStale(stale, unbound, {}, () => stamp + 1000, spec),
    stale,
  );
  // Custom stamps and ordinary non-document families keep their own columns.
  assert.ok(
    crossCheckSql(
      { neurons: { ...spec.neurons, column: "updated_at" } },
      env,
    ).includes("MAX(updated_at) FROM neurons)"),
  );
});

const captureNetwork = async (
  at: number,
  first: number,
  count: number,
  expected = 129,
) =>
  writeNeuronDocuments(store(), {
    ...empty(),
    rows: Array.from({ length: count }, (_, i) => ({
      netuid: first + i,
      uid: 0,
      captured_at: at,
      hotkey: `5key${first + i}`,
      coldkey: "5cold",
    })),
    pass: {
      capturedAt: at,
      expectedRows: expected,
      receivedRows: count,
      nowMs: at + 1000,
    },
  });

const coverage = (now: number) =>
  store().first<{
    latest: number | null;
    total: number;
    covered: number;
    uploading: number;
  }>(NEURONS_D1_COVERAGE_SQL, [now, now - 300_000, 300_000]);

test("native coverage observes bounded upload progress without reporting a truncated completed pass", async () => {
  const next = stamp + 900_000;
  await captureNetwork(stamp, 0, 129);
  await captureNetwork(next, 0, 42);
  const old = await store().first<{ covered: number }>(
    NEURONS_COVERAGE_SQL,
    [300_000],
  );
  assert.equal(
    old?.covered,
    42,
    "reproduces the production alert during an upload",
  );
  assert.deepEqual(await coverage(next + 10_000), {
    latest: stamp,
    total: 129,
    covered: 129,
    uploading: 1,
  });
  await captureNetwork(next, 42, 87);
  assert.deepEqual(await coverage(next + 20_000), {
    latest: next,
    total: 129,
    covered: 129,
    uploading: 0,
  });
});

test("an abandoned or completed partial native capture still alerts", async () => {
  const next = stamp + 900_000;
  await captureNetwork(stamp, 0, 129);
  await captureNetwork(next, 0, 42);
  assert.deepEqual(await coverage(next + 300_001), {
    latest: next,
    total: 129,
    covered: 42,
    uploading: 0,
  });
  await db
    .prepare(
      "UPDATE neurons_passes SET expected_rows=42,completed_at=? WHERE captured_at=?",
    )
    .bind(next + 1000, next)
    .run();
  assert.deepEqual(await coverage(next + 2000), {
    latest: next,
    total: 129,
    covered: 42,
    uploading: 0,
  });
  await db
    .prepare("DELETE FROM neurons_passes WHERE captured_at=?")
    .bind(next)
    .run();
  assert.deepEqual(await coverage(next + 2000), {
    latest: next,
    total: 129,
    covered: 42,
    uploading: 0,
  });
});

test("in-flight proof cannot hide stale history or bootstrap without a completed capture", async () => {
  const next = stamp + 3_600_000;
  await captureNetwork(next, 0, 42);
  assert.deepEqual(await coverage(next + 2000), {
    latest: next,
    total: 42,
    covered: 42,
    uploading: 0,
  });
  await captureNetwork(stamp, 42, 87, 87);
  const result = (await coverage(next + 2000))!;
  assert.equal(result.latest, stamp);
  assert.equal(result.uploading, 1);
  assert.equal(
    evaluateNeuronsStaleness({
      latestCapturedAtMs: result.latest,
      coveredNetuids: result.covered,
      totalNetuids: result.total,
      nowMs: next + 2000,
      thresholdMs: 2_700_000,
      coverageFloorNetuids: 103,
    }).reason,
    "stale",
  );
});

test("empty native shards do not count as subnet coverage", async () => {
  await captureNetwork(stamp, 0, 1, 1);
  await db
    .prepare("INSERT INTO neurons_documents VALUES(999,'',0,?,jsonb('{}'))")
    .bind(stamp + 900_000)
    .run();
  const legacy = await store().first(NEURONS_COVERAGE_SQL, [300_000]);
  const native = await coverage(stamp + 901_000);
  assert.deepEqual(native, { ...legacy, uploading: 0 });
});

test("the production watchdog selects native capture proof and persists its bounded verdict", async () => {
  const next = stamp + 900_000;
  await captureNetwork(stamp, 0, 129);
  await captureNetwork(next, 0, 42);
  const writes: unknown[][] = [];
  const errors: string[] = [];
  const tick = (now: number) =>
    runNeuronsStalenessWatchdog(
      { D1_STATE: db, D1_STATE_TABLES: owners },
      {
        now: () => now,
        laneHealthDb: {
          query: async () => [],
          run: async (_sql, values = []) => {
            writes.push(values);
            return { changes: 1 };
          },
        },
        recordException: async (_env, event) => {
          errors.push(String(event.error));
          return true;
        },
      },
    );
  const uploading = await tick(next + 10_000);
  assert.equal(uploading.ok, true);
  assert.equal(uploading.alerted, false);
  assert.equal(uploading.covered_netuids, 129);
  assert.equal(errors.length, 0);
  assert.ok(
    writes.some(
      (values) =>
        values.includes("ok") &&
        values.some(
          (v) => typeof v === "string" && v.includes("capture_in_flight=1"),
        ),
    ),
  );

  const expired = await tick(next + 300_001);
  assert.equal(expired.ok, true);
  assert.equal(expired.alerted, true);
  assert.equal(expired.reason, "partial");
  assert.match(errors[0], /covered only 42 of 129/);

  await captureNetwork(next, 42, 87);
  const complete = await tick(next + 310_000);
  assert.equal(complete.ok, true);
  assert.equal(complete.alerted, false);
  assert.equal(complete.covered_netuids, 129);
  assert.equal(errors.length, 1);
});
