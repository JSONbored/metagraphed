import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import {
  alphaCountAnchorSchema,
  alphaCountsOwnerStore,
  readAlphaCountStatusD1,
  writeAlphaCountsD1,
  type AlphaCountAnchor,
} from "../src/alpha-counts-d1.ts";
import { writeAlphaSnapshotD1 } from "../src/alpha-snapshot-d1.ts";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
} from "../src/alpha-runtime-identity.ts";
import { createD1Store } from "../src/d1-store.ts";
import type { ProducerStore } from "../src/producer-store.ts";
import type { Row } from "./row-type.ts";

const frozen = JSON.parse(
  readFileSync(
    new URL("./fixtures/alpha-runtime/frozen-478.json", import.meta.url),
    "utf8",
  ),
) as Row;
const metadata = readFileSync(
  new URL("./fixtures/alpha-runtime/metadata-479.hex", import.meta.url),
  "utf8",
).trim();
const AT = frozen.alpha_snapshot.captured_at as number;
const runtimes: Miniflare[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

async function fixture() {
  vi.useRealTimers();
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('counts')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  runtimes.push(runtime);
  const db = await runtime.getD1Database("DB");
  for (const file of [
    "0010_ledger_state.sql",
    "0016_archive_export_revisions.sql",
    "0039_alpha_runtime_receiver.sql",
  ]) {
    const sql = readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("-- statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  return { db, store: createD1Store(db) };
}

function member(coldkey: string, hotkey: string, netuid = 23) {
  return {
    coldkey,
    hotkey,
    netuid,
    evidence: structuredClone(frozen.members[0].evidence),
  };
}

function anchorFor(
  members: number,
  capturedAt = AT,
  block = 100,
  excluded = 0,
): AlphaCountAnchor {
  return alphaCountAnchorSchema.parse({
    captured_at: capturedAt,
    block_number: block,
    block_hash: `0x${block.toString(16).padStart(64, "0")}`,
    genesis_hash: ALPHA_GENESIS,
    spec_version: 479,
    code_hash: ALPHA_RUNTIMES[479].code,
    metadata_sha256: ALPHA_RUNTIMES[479].metadata,
    scanned_legacy: 0,
    scanned_v2: members + excluded,
    distinct_members: members + excluded,
    excluded_root_members: excluded,
  });
}

async function publish(
  db: D1Database,
  members = [member("alice", "hot-a"), member("bob", "hot-b")],
  capturedAt = AT,
  block = 100,
  excluded = 0,
) {
  const anchor = anchorFor(members.length, capturedAt, block, excluded);
  await writeAlphaSnapshotD1(
    db,
    {
      alpha_snapshot: {
        ...anchor,
        metadata_scale_hex: metadata,
        total_rows: members.length,
        total_chunks: 1,
        index: 0,
      },
      rows: members,
    },
    capturedAt + 1,
  );
  return anchor;
}

function countRow(anchor: AlphaCountAnchor, hotkey: string, count = 1) {
  return {
    hotkey,
    nominator_count: count,
    captured_at: anchor.captured_at,
  };
}

async function state(store: ProducerStore) {
  return Promise.all([
    store.query("SELECT * FROM validator_nominator_counts ORDER BY hotkey"),
    store.query(
      "SELECT * FROM validator_nominator_counts_passes ORDER BY captured_at",
    ),
    store.query(
      "SELECT * FROM alpha_snapshot_rows " +
        "ORDER BY captured_at,coldkey,hotkey,netuid",
    ),
  ]);
}

test("count receipts measure distinct delivery and exact replay", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, [
    member("alice", "hot-a"),
    member("bob", "hot-b"),
    member("carol", "hot-c"),
  ]);
  const absent = await readAlphaCountStatusD1(store, anchor);
  assert.equal(absent.pass_total, null);
  assert.equal(absent.complete, false);
  const waiting = await readAlphaCountStatusD1(store, anchor, 3);
  assert.equal(waiting.applied_count, 0);
  assert.equal(waiting.complete, false);
  assert.equal(waiting.current, true);
  assert.equal(waiting.completed_at, null);
  const first = [countRow(anchor, "hot-a")];
  const partial = await writeAlphaCountsD1(store, first, anchor, 3, AT + 10);
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.alpha_snapshot, anchor);
  assert.equal(partial.pass_total, 3);
  assert.equal(partial.applied_count, 1);
  assert.equal(partial.complete, false);
  assert.equal(partial.current, true);
  assert.equal(partial.completed_at, null);
  const beforeReplay = await state(store);
  await writeAlphaCountsD1(store, first, anchor, 3, AT + 11);
  assert.deepEqual(await state(store), beforeReplay);
  const status = await readAlphaCountStatusD1(store, anchor, 3);
  assert.equal(status.applied_count, 1);
  assert.equal(status.complete, false);
  await writeAlphaCountsD1(
    store,
    [countRow(anchor, "hot-b")],
    anchor,
    3,
    AT + 12,
  );
  const two = await readAlphaCountStatusD1(store, anchor);
  assert.equal(two.applied_count, 2);
  assert.equal(two.complete, false);
  const complete = await writeAlphaCountsD1(
    store,
    [countRow(anchor, "hot-c")],
    anchor,
    3,
    AT + 13,
  );
  assert.equal(complete.applied_count, 3);
  assert.equal(complete.complete, true);
  assert.equal(complete.completed_at, AT + 13);
  const terminal = await state(store);
  await writeAlphaCountsD1(store, first, anchor, 3, AT + 14);
  assert.deepEqual(await state(store), terminal);
});

test("count completion clocks are independent of producer capture clocks", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db);
  const rows = [countRow(anchor, "hot-a"), countRow(anchor, "hot-b")];
  const before = await state(store);
  await assert.rejects(writeAlphaCountsD1(store, rows, anchor, 2, 0));
  assert.deepEqual(await state(store), before);

  const now = anchor.captured_at - 1;
  const receipt = await writeAlphaCountsD1(store, rows, anchor, 2, now);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.current, true);
  assert.equal(receipt.pass_total, 2);
  assert.equal(receipt.applied_count, 2);
  assert.equal(receipt.completed_at, now);
  assert.deepEqual(await readAlphaCountStatusD1(store, anchor, 2), receipt);
  const terminal = await state(store);
  const replay = await writeAlphaCountsD1(store, rows, anchor, 2, AT + 10);
  assert.deepEqual(replay, receipt);
  assert.deepEqual(await state(store), terminal);
});

test("block order overrides clocks and rejects delayed work", async () => {
  const { db, store } = await fixture();
  const a = await publish(db, undefined, AT + 100, 100);
  await writeAlphaCountsD1(
    store,
    [countRow(a, "hot-a"), countRow(a, "hot-b")],
    a,
    2,
    AT + 200,
  );
  const b = await publish(
    db,
    [member("alice", "hot-a"), member("bob", "hot-a")],
    AT,
    101,
  );
  const accepted = await writeAlphaCountsD1(
    store,
    [countRow(b, "hot-a", 2)],
    b,
    1,
    AT + 201,
  );
  assert.equal(accepted.complete, true);
  assert.equal(accepted.current, true);
  const actual = await store.first(
    "SELECT nominator_count,captured_at " +
      "FROM validator_nominator_counts WHERE hotkey=?",
    ["hot-a"],
  );
  assert.deepEqual(actual, { nominator_count: 2, captured_at: AT });
  const before = await state(store);
  await assert.rejects(
    writeAlphaCountsD1(store, [countRow(a, "late-hotkey")], a, 2, AT + 202),
  );
  assert.deepEqual(await state(store), before);
  assert.equal((await readAlphaCountStatusD1(store, a)).current, false);
  assert.equal((await readAlphaCountStatusD1(store, b)).current, true);
});

test("mutated anchors, declarations and counts roll back", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db);
  await writeAlphaCountsD1(
    store,
    [countRow(anchor, "hot-a")],
    anchor,
    2,
    AT + 10,
  );
  const before = await state(store);
  const changedHash = `0x${"f".repeat(64)}`;
  const changed = [
    { ...anchor, block_hash: changedHash },
    { ...anchor, block_number: 101 },
    { ...anchor, scanned_v2: 3, distinct_members: 3 },
    {
      ...anchor,
      scanned_v2: 3,
      distinct_members: 3,
      excluded_root_members: 1,
    },
  ];
  for (const mutated of changed) {
    await assert.rejects(
      writeAlphaCountsD1(
        store,
        [countRow(anchor, "hot-b")],
        mutated,
        2,
        AT + 11,
      ),
    );
    assert.deepEqual(await state(store), before);
  }
  await assert.rejects(
    writeAlphaCountsD1(store, [countRow(anchor, "hot-b")], anchor, 1, AT + 11),
  );
  await assert.rejects(readAlphaCountStatusD1(store, anchor, 1));
  await assert.rejects(
    writeAlphaCountsD1(
      store,
      [countRow(anchor, "hot-b"), countRow(anchor, "hot-a", 2)],
      anchor,
      2,
      AT + 12,
    ),
  );
  assert.deepEqual(await state(store), before);
});

test("one omitted hotkey cannot be replaced by replay overshoot", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db);
  const rows = [countRow(anchor, "hot-a")];
  for (let index = 0; index < 4; index++) {
    const result = await writeAlphaCountsD1(
      store,
      rows,
      anchor,
      2,
      AT + 10 + index,
    );
    assert.equal(result.applied_count, 1);
    assert.equal(result.complete, false);
    assert.equal(result.completed_at, null);
  }
});

test("feasible root alternatives cannot rewrite a receipt", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, undefined, AT, 100, 1);
  await writeAlphaCountsD1(
    store,
    [countRow(anchor, "hot-a")],
    anchor,
    2,
    AT + 10,
  );
  const before = await state(store);
  // Both declarations fit the census, but the acknowledged one is immutable.
  await assert.rejects(
    writeAlphaCountsD1(store, [countRow(anchor, "hot-b")], anchor, 3, AT + 11),
  );
  await assert.rejects(readAlphaCountStatusD1(store, anchor, 3));
  // The root could add a coldkey to hot-a, but an identical capture cannot
  // change the hot-a count it already acknowledged as one.
  await assert.rejects(
    writeAlphaCountsD1(
      store,
      [countRow(anchor, "hot-a", 2)],
      anchor,
      2,
      AT + 12,
    ),
  );
  assert.deepEqual(await state(store), before);
});

test("counts must cover and match known non-root members", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db);
  const before = await state(store);
  const rejected = [
    { rows: [countRow(anchor, "hot-a")], total: 1 },
    {
      rows: [countRow(anchor, "hot-a"), countRow(anchor, "unknown")],
      total: 2,
    },
    { rows: [countRow(anchor, "hot-a", 2)], total: 2 },
    { rows: [countRow(anchor, "hot-a", 0)], total: 2 },
    { rows: [countRow(anchor, "hot-a", 3)], total: 2 },
  ];
  for (const input of rejected) {
    await assert.rejects(
      writeAlphaCountsD1(store, input.rows, anchor, input.total, AT + 10),
    );
    assert.deepEqual(await state(store), before);
  }
});

test("root-only terminal counts cover every distinct root pair", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, [], AT, 100, 3);
  const before = await state(store);
  await assert.rejects(
    writeAlphaCountsD1(
      store,
      [countRow(anchor, "root-only", 2)],
      anchor,
      1,
      AT + 10,
    ),
  );
  assert.deepEqual(await state(store), before);
  const rows = [countRow(anchor, "root-only", 3)];
  const receipt = await writeAlphaCountsD1(store, rows, anchor, 1, AT + 11);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.current, true);
  assert.equal(receipt.applied_count, 1);
  assert.deepEqual(await readAlphaCountStatusD1(store, anchor, 1), receipt);
});

test("root coverage is required only when all count keys arrive", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, [], AT, 100, 3);
  const first = [countRow(anchor, "root-a")];
  const partial = await writeAlphaCountsD1(store, first, anchor, 2, AT + 10);
  assert.equal(partial.complete, false);
  assert.equal(partial.applied_count, 1);
  const before = await state(store);
  await assert.rejects(
    writeAlphaCountsD1(
      store,
      [countRow(anchor, "root-b")],
      anchor,
      2,
      AT + 11,
    ),
  );
  assert.deepEqual(await state(store), before);
  const last = [countRow(anchor, "root-b", 2)];
  const receipt = await writeAlphaCountsD1(store, last, anchor, 2, AT + 12);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.applied_count, 2);
});

test("root and non-root members can share a single counted pair", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, [member("alice", "hot-a")], AT, 100, 1);
  const rows = [countRow(anchor, "hot-a")];
  const receipt = await writeAlphaCountsD1(store, rows, anchor, 1, AT + 10);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.current, true);
  assert.equal(receipt.applied_count, 1);
  const row = await store.first(
    "SELECT nominator_count FROM validator_nominator_counts WHERE hotkey=?",
    ["hot-a"],
  );
  assert.equal(row?.nominator_count, 1);
});

test("root allowance cannot hide a missing non-root hotkey", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, undefined, AT, 100, 1);
  const before = await state(store);
  await assert.rejects(
    writeAlphaCountsD1(
      store,
      [countRow(anchor, "hot-a"), countRow(anchor, "root-only")],
      anchor,
      2,
      AT + 10,
    ),
  );
  assert.deepEqual(await state(store), before);
});

test("partial root allowance is conserved across count chunks", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, undefined, AT, 100, 1);
  const partial = await writeAlphaCountsD1(
    store,
    [countRow(anchor, "hot-a", 2)],
    anchor,
    2,
    AT + 10,
  );
  assert.equal(partial.applied_count, 1);
  assert.equal(partial.complete, false);
  const before = await state(store);
  await assert.rejects(
    writeAlphaCountsD1(
      store,
      [countRow(anchor, "hot-b", 2)],
      anchor,
      2,
      AT + 11,
    ),
  );
  assert.deepEqual(await state(store), before);
  const complete = await writeAlphaCountsD1(
    store,
    [countRow(anchor, "hot-b")],
    anchor,
    2,
    AT + 12,
  );
  assert.equal(complete.complete, true);
  assert.equal(complete.applied_count, 2);
});

test("native failure rolls back both gauges and receipt", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db);
  const before = await state(store);
  let injected = false;
  const faulty: ProducerStore = {
    ...store,
    async transaction(statements) {
      const index = statements.findIndex((statement) =>
        statement.text.includes("INSERT INTO validator_nominator_counts("),
      );
      assert.ok(index >= 0);
      injected = true;
      return store.transaction([
        ...statements.slice(0, index + 1),
        { text: "SELECT json('injected native failure')" },
        ...statements.slice(index + 1),
      ]);
    },
  };
  await assert.rejects(
    writeAlphaCountsD1(
      faulty,
      [countRow(anchor, "hot-a")],
      anchor,
      2,
      AT + 10,
    ),
  );
  assert.equal(injected, true);
  assert.deepEqual(await state(store), before);
});

test("a missing readback cannot acknowledge a native count write", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db);
  const missing: ProducerStore = {
    ...store,
    async first() {
      return null;
    },
  };
  const rows = [countRow(anchor, "hot-a")];
  await assert.rejects(writeAlphaCountsD1(missing, rows, anchor, 2, AT + 10));
  const confirmed = await readAlphaCountStatusD1(store, anchor);
  assert.equal(confirmed.applied_count, 1);
  assert.equal(confirmed.complete, false);
  const before = await state(store);
  await writeAlphaCountsD1(store, rows, anchor, 2, AT + 11);
  assert.deepEqual(await state(store), before);
});

test("empty raw captures receive a terminal zero receipt", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db, []);
  const receipt = await writeAlphaCountsD1(store, [], anchor, 0, AT + 10);
  assert.equal(receipt.pass_total, 0);
  assert.equal(receipt.applied_count, 0);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.current, true);
  assert.equal(receipt.completed_at, AT + 10);
  const before = await state(store);
  await writeAlphaCountsD1(store, [], anchor, 0, AT + 20);
  assert.deepEqual(await state(store), before);
});

test("raw counts include root, stored-zero and retired members", async () => {
  const { db, store } = await fixture();
  const zero = member("stored-zero", "hot-zero");
  zero.evidence.share.v2 = { mantissa: "0", exponent: "0" };
  const retired = member("retired", "hot-retired");
  retired.evidence.pool_epoch = "2";
  retired.evidence.member_epoch = "1";
  const members = [zero, { ...zero, netuid: 24 }, retired];
  const anchor = await publish(db, members, AT, 100, 1);
  const receipt = await writeAlphaCountsD1(
    store,
    [
      countRow(anchor, "hot-zero"),
      countRow(anchor, "hot-retired"),
      countRow(anchor, "root-only"),
    ],
    anchor,
    3,
    AT + 10,
  );
  assert.equal(receipt.applied_count, 3);
  assert.equal(receipt.complete, true);
  const originals = await store.query<{ alpha_rao: string }>(
    "SELECT alpha_rao FROM alpha_snapshot_rows ORDER BY coldkey",
  );
  assert.deepEqual(
    originals.map((row) => row.alpha_rao),
    ["0", "0", "0"],
  );
  const distinctColdkeys = await store.first(
    "SELECT nominator_count FROM validator_nominator_counts WHERE hotkey=?",
    ["hot-zero"],
  );
  assert.equal(distinctColdkeys?.nominator_count, 1);
});

test("selection fences legacy count and receipt writes", async () => {
  const { db, store } = await fixture();
  const legacyInsert =
    "INSERT INTO validator_nominator_counts VALUES('legacy',1,?)";
  await store.run(legacyInsert, [AT - 1]);
  const anchor = await publish(db);
  const before = await state(store);
  await assert.rejects(
    store.run("INSERT INTO validator_nominator_counts VALUES('new',1,?)", [AT]),
  );
  await assert.rejects(
    store.run(
      "UPDATE validator_nominator_counts SET nominator_count=2,captured_at=?",
      [AT],
    ),
  );
  await assert.rejects(
    store.run(
      "INSERT INTO validator_nominator_counts_passes" +
        "(captured_at,expected_rows,received_rows) VALUES(?,2,1)",
      [AT],
    ),
  );
  assert.deepEqual(await state(store), before);
  await writeAlphaCountsD1(
    store,
    [countRow(anchor, "hot-a")],
    anchor,
    2,
    AT + 10,
  );
  const anchored = await state(store);
  await assert.rejects(
    store.run(
      "UPDATE validator_nominator_counts SET nominator_count=2 " +
        "WHERE hotkey='hot-a'",
    ),
  );
  await assert.rejects(
    store.run(
      "DELETE FROM validator_nominator_counts_passes WHERE captured_at=?",
      [AT],
    ),
  );
  assert.deepEqual(await state(store), anchored);
});

test("invalid rows and declarations fail before native writes", async () => {
  const { db, store } = await fixture();
  const anchor = await publish(db);
  const valid = countRow(anchor, "hot-a");
  const before = await state(store);
  const invalidRows = [
    [{ ...valid, captured_at: AT + 1 }],
    [{ ...valid, hotkey: 1 }],
    [{ ...valid, hotkey: "" }],
    [{ ...valid, hotkey: "😀".repeat(33) }],
    [{ ...valid, nominator_count: 1.5 }],
    [{ ...valid, nominator_count: -1 }],
    [valid, valid],
  ];
  for (const rows of invalidRows) {
    await assert.rejects(writeAlphaCountsD1(store, rows, anchor, 2, AT + 10));
  }
  for (const total of [NaN, -1, 5_000_001, 0]) {
    await assert.rejects(
      writeAlphaCountsD1(store, [valid], anchor, total, AT + 10),
    );
  }
  for (const now of [NaN, 0, -1, 1.5]) {
    await assert.rejects(writeAlphaCountsD1(store, [valid], anchor, 2, now));
  }
  await assert.rejects(writeAlphaCountsD1(store, [], anchor, 0, AT + 10));
  assert.deepEqual(await state(store), before);
});

test("count owners require one bound native family", async () => {
  const { db } = await fixture();
  const tables = [
    "nominator_positions",
    "nominator_positions_passes",
    "nominator_scan_receipts",
    "validator_nominator_counts",
    "validator_nominator_counts_passes",
  ];
  const env = { D1_STATE: db, D1_STATE_TABLES: tables.join(",") };
  assert.ok(alphaCountsOwnerStore(env));
  assert.equal(alphaCountsOwnerStore({}), null);
  assert.throws(() =>
    alphaCountsOwnerStore({ D1_STATE_TABLES: tables.join(",") }),
  );
  assert.throws(() =>
    alphaCountsOwnerStore({
      ...env,
      D1_STATE_TABLES: tables.slice(0, -1).join(","),
    }),
  );
});

test("count anchors bind exact runtime identity and raw census", () => {
  for (const spec of [454, 478, 479] as const) {
    const runtime = ALPHA_RUNTIMES[spec];
    const anchor = {
      ...anchorFor(1),
      spec_version: spec,
      code_hash: runtime.code,
      metadata_sha256: runtime.metadata,
    };
    assert.deepEqual(alphaCountAnchorSchema.parse(anchor), anchor);
  }
  const anchor = anchorFor(1);
  const invalid = [
    { ...anchor, block_number: 0x1_0000_0000 },
    { ...anchor, code_hash: `0x${"0".repeat(64)}` },
    { ...anchor, metadata_sha256: "0".repeat(64) },
    { ...anchor, scanned_legacy: 1, distinct_members: 2 },
    { ...anchor, distinct_members: 0 },
    { ...anchor, distinct_members: 2 },
    { ...anchor, excluded_root_members: 2 },
    { ...anchor, index: 0 },
  ];
  for (const value of invalid) {
    assert.throws(() => alphaCountAnchorSchema.parse(value));
  }
});
