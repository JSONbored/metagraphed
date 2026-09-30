import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import type {
  ProducerStatement,
  ProducerStore,
} from "../src/producer-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});
const stamp = 1790800000000;
function capture(uids = [0], total = 2, at = stamp) {
  const rows = uids.map((uid) => ({
    netuid: 1,
    uid,
    captured_at: at,
    hotkey: `key-${uid}`,
    coldkey: null,
    stake_tao: uid + 0.125,
    active: true,
  }));
  return {
    ...neuronSnapshotWrite(rows, at + 1000),
    pass: {
      capturedAt: at,
      expectedRows: total,
      receivedRows: rows.length,
      nowMs: at + 1000,
    },
  };
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const file of [
    "0007_neuron_documents.sql",
    "0037_neuron_capture_batch_receipts.sql",
  ])
    db.exec(
      readFileSync(
        new URL(`../migrations/d1/${file}`, import.meta.url),
        "utf8",
      ),
    );
  let calls = 0,
    reads = 0;
  let fail: ((phase: string, call: number, index?: number) => void) | undefined;
  let readback: ((row: unknown) => unknown) | undefined;
  const store = {
    async transaction(statements: readonly ProducerStatement[]) {
      const call = ++calls;
      fail?.("before", call);
      db.exec("BEGIN");
      let result;
      try {
        result = statements.map((statement, index) => {
          fail?.("statement", call, index);
          return {
            changes: Number(
              db.prepare(statement.text).run(...(statement.values as never[]))
                .changes,
            ),
          };
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      fail?.("commit", call);
      return result;
    },
    async first<Row>(text: string, values: unknown[] = []) {
      fail?.("read", ++reads);
      const row = db.prepare(text).get(...(values as never[])) ?? null;
      return (readback ? readback(row) : row) as Row | null;
    },
  } as ProducerStore;
  return {
    db,
    store,
    calls: () => calls,
    fault(fn?: typeof fail) {
      fail = fn;
    },
    readWith(fn?: typeof readback) {
      readback = fn;
    },
    pass: () => ({ ...db.prepare("SELECT * FROM neurons_passes").get() }),
    census: () =>
      ["neurons", "neuron_daily", "account_position_daily"].map(
        (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
      ),
  };
}
async function finish(promise: Promise<unknown>) {
  await vi.runAllTimersAsync();
  return promise;
}
const transient = [
  "D1_ERROR: Network connection lost.",
  "Network connection lost.",
  "D1_ERROR: Replica disconnected from primary.",
  "D1_ERROR: D1 DB reset because its code was updated.",
  "D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
  "D1_ERROR: Internal error in D1 DB storage caused object to be reset.",
  "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.",
  "D1_ERROR: internal error; reference = e_provider_reset",
];
for (const message of transient)
  for (const phase of ["before", "commit", "read"]) {
    test(`one safe retry after ${phase}: ${message}`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      f.fault((where, call) => {
        if (where === phase && call === 1) throw new Error(message);
      });
      await finish(writeNeuronDocuments(f.store, capture()));
      assert.equal(f.calls(), 2);
      assert.deepEqual(f.census(), [1, 1, 1]);
      assert.equal(f.pass().received_rows, 1);
      assert.equal(f.pass().completed_at, null);
      assert.equal(
        f.db.prepare("SELECT applied FROM neurons_capture_batches").get()
          ?.applied,
        1,
      );
    });
  }
test("reordered producer resends preserve the incomplete tally and the next distinct chunk completes it", async () => {
  const f = fixture();
  const first = capture([0, 1], 3);
  await writeNeuronDocuments(f.store, first);
  await writeNeuronDocuments(f.store, {
    ...first,
    rows: [...first.rows].reverse(),
    dailyRows: [...first.dailyRows].reverse(),
    positionRows: [...first.positionRows].reverse(),
    pass: { ...first.pass, nowMs: stamp + 5000 },
  });
  assert.equal(f.pass().received_rows, 2);
  assert.equal(f.pass().completed_at, null);
  await writeNeuronDocuments(f.store, capture([2], 3));
  assert.equal(f.pass().received_rows, 3);
  assert.equal(f.pass().completed_at, stamp + 1000);
  assert.deepEqual(f.census(), [3, 3, 3]);
});
test("a changed payload with the same stable chunk membership rolls back instead of recounting", async () => {
  const f = fixture();
  await writeNeuronDocuments(f.store, capture());
  const changed = capture();
  changed.rows[0]!.stake_tao = 99;
  await assert.rejects(writeNeuronDocuments(f.store, changed), /NOT NULL/);
  assert.equal(f.pass().received_rows, 1);
  assert.equal(
    f.db.prepare("SELECT stake_tao FROM neurons").get()?.stake_tao,
    0.125,
  );
});
test("all families and the receipt roll back together when the final tally fails", async () => {
  const f = fixture();
  f.db.exec(
    "CREATE TRIGGER reject BEFORE INSERT ON neurons_passes BEGIN SELECT RAISE(ABORT,'reject tally'); END",
  );
  await assert.rejects(
    writeNeuronDocuments(f.store, capture()),
    /reject tally/,
  );
  assert.deepEqual(f.census(), [0, 0, 0]);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM neurons_capture_batches").get()?.n,
    0,
  );
  assert.equal(f.calls(), 1);
});
test("completed receipt cleanup preserves historical counts and late resends cannot count again", async () => {
  const f = fixture();
  const input = capture([0], 1);
  await writeNeuronDocuments(f.store, input);
  await writeNeuronDocuments(f.store, {
    ...input,
    pass: { ...input.pass, nowMs: stamp + 700000 },
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM neurons_capture_batches").get()?.n,
    0,
  );
  assert.equal(f.pass().received_rows, 1);
  assert.equal(f.pass().completed_at, stamp + 1000);
  assert.deepEqual(f.census(), [1, 1, 1]);
});
test("old incomplete receipts remain pinned and a delayed resend stays incomplete", async () => {
  const f = fixture();
  const input = capture();
  await writeNeuronDocuments(f.store, input);
  await writeNeuronDocuments(f.store, {
    ...input,
    pass: { ...input.pass, nowMs: stamp + 700000 },
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM neurons_capture_batches").get()?.n,
    1,
  );
  assert.equal(f.pass().received_rows, 1);
  assert.equal(f.pass().completed_at, null);
});
for (const failure of [
  new Error("D1_ERROR: overloaded"),
  new Error("database or disk is full"),
  new Error("invalid JSON"),
  "Network connection lost.",
  null,
]) {
  test(`terminal failures remain visible without a retry: ${String(failure)}`, async () => {
    const f = fixture();
    f.fault((phase) => {
      if (phase === "before") throw failure;
    });
    await assert.rejects(
      writeNeuronDocuments(f.store, capture()),
      (error) => error === failure,
    );
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.census(), [0, 0, 0]);
  });
}
test("persistent transient failures stop after two attempts", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fault((phase) => {
    if (phase === "before") throw new Error(transient[0]);
  });
  const rejected = assert.rejects(
    writeNeuronDocuments(f.store, capture()),
    /Network connection lost/,
  );
  await finish(rejected);
  assert.equal(f.calls(), 2);
});
for (const receipt of [
  null,
  { sha256: "wrong", applied: 1 },
  { sha256: "wrong", applied: 0 },
]) {
  test(`an unqualified acknowledgement never reports success: ${JSON.stringify(receipt)}`, async () => {
    const f = fixture();
    f.readWith(() => receipt);
    await assert.rejects(
      writeNeuronDocuments(f.store, capture()),
      /not acknowledged/,
    );
    assert.equal(f.calls(), 1);
    assert.equal(f.pass().received_rows, 1);
  });
}
test("receipt-free captures also replay an idempotent lost commit reply safely", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fault((phase, call) => {
    if (phase === "commit" && call === 1) throw new Error(transient[0]);
  });
  const { pass: _, ...input } = capture();
  await finish(writeNeuronDocuments(f.store, input));
  assert.deepEqual(f.census(), [1, 1, 1]);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM neurons_capture_batches").get()?.n,
    0,
  );
});

test("ordering across netuids and per-member booleans stays stable on a resend", async () => {
  const f = fixture();
  const input = capture([0, 1], 3);
  input.rows[0]!.netuid = 2;
  input.rows[0]!.active = false;
  const derived = {
    ...neuronSnapshotWrite(input.rows, stamp + 1000),
    pass: input.pass,
  };
  await writeNeuronDocuments(f.store, derived);
  await writeNeuronDocuments(f.store, {
    ...derived,
    rows: [...derived.rows].reverse(),
  });
  assert.equal(f.pass().received_rows, 2);
  assert.equal(f.pass().completed_at, null);
});

test("a matching checksum with an unapplied receipt cannot acknowledge the write", async () => {
  const f = fixture();
  f.readWith((row) => (row ? { ...(row as object), applied: 0 } : row));
  await assert.rejects(
    writeNeuronDocuments(f.store, capture()),
    /not acknowledged/,
  );
});

for (const mutation of [
  "",
  "UPDATE neurons_passes SET received_rows=expected_rows",
  "UPDATE neurons_passes SET received_rows=expected_rows,completed_at=captured_at-1",
]) {
  test(`a missing receipt needs a genuinely complete pass: ${mutation}`, async () => {
    const f = fixture();
    await writeNeuronDocuments(f.store, capture());
    if (mutation) f.db.exec(mutation);
    f.readWith((row) =>
      row && Object.hasOwn(row as object, "sha256") ? null : row,
    );
    await assert.rejects(
      writeNeuronDocuments(f.store, capture()),
      /not acknowledged/,
    );
  });
}

test("cleanup removes at most 200 completed receipts and keeps incomplete history", async () => {
  const f = fixture();
  f.db
    .prepare("INSERT INTO neurons_passes VALUES(?,?,?,?)")
    .run(stamp - 700000, 1, 1, stamp - 699999);
  const insert = f.db.prepare(
    "INSERT INTO neurons_capture_batches VALUES(?,?,?,1)",
  );
  for (let i = 0; i < 205; i++)
    insert.run(
      i.toString(16).padStart(64, "0"),
      stamp - 700000,
      "a".repeat(64),
    );
  f.db
    .prepare("INSERT INTO neurons_passes VALUES(?,?,?,NULL)")
    .run(stamp - 800000, 2, 1);
  insert.run("b".repeat(64), stamp - 800000, "a".repeat(64));
  await writeNeuronDocuments(f.store, capture());
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM neurons_capture_batches").get()?.n,
    7,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM neurons_passes").get()?.n,
    3,
  );
  assert.equal(
    f.db
      .prepare("SELECT applied FROM neurons_capture_batches WHERE batch_id=?")
      .get("b".repeat(64))?.applied,
    1,
  );
});
