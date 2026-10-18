import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { createD1Store, type D1StoreBinding } from "../src/d1-store.ts";
import {
  neuronDocumentStatements,
  writeNeuronDocuments,
} from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import type { NeuronMirrorInput } from "../src/neurons-neon-write.ts";
import type { ProducerStatement } from "../src/producer-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const stamp = Date.parse("2026-09-22T12:00:00Z");
const families = ["neurons", "neuron_daily", "account_position_daily"];
const tables = [
  ...families.flatMap((family) => [`${family}_documents`, `${family}_members`]),
  "neurons_capture_batches",
  "neurons_passes",
  "archive_export_revisions",
];
function row(uid: number, at = stamp, netuid = 1) {
  return {
    netuid,
    uid,
    captured_at: at,
    hotkey: `key-${netuid}-${uid}`,
    coldkey: `owner-${netuid}`,
    active: true,
    axon: "1.2.3.4:8091",
  };
}
function capture(rows: ReturnType<typeof row>[]): NeuronMirrorInput {
  return neuronSnapshotWrite(rows, stamp + 10_000);
}
function isPrune(statement: ProducerStatement) {
  return (
    statement.text.startsWith("DELETE FROM neurons_members") ||
    statement.text.startsWith("UPDATE neurons_documents SET payload=jsonb(")
  );
}
// Restore the previous schedule from the SAME statements. This comparator
// changes ordering only; it does not duplicate the production SQL or bindings.
function previousOrder(statements: readonly ProducerStatement[]) {
  const prune = statements.filter(isPrune);
  const rest = statements.filter((statement) => !isPrune(statement));
  const receipt = rest.findIndex((statement) =>
    statement.text.startsWith("DELETE FROM neurons_capture_batches"),
  );
  const at = receipt < 0 ? rest.length : receipt;
  return [...rest.slice(0, at), ...prune, ...rest.slice(at)];
}
function fixture(previous = false) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const name of [
    "0007_neuron_documents.sql",
    "0012_neuron_daily_join_index.sql",
    "0016_archive_export_revisions.sql",
    "0020_neuron_axon_projection.sql",
    "0022_neuron_document_dates.sql",
    "0026_closed_day_export_revisions.sql",
    "0030_neuron_axon_insert_projection.sql",
    "0031_neuron_axon_document_projection.sql",
    "0032_daily_coverage_covering_indexes.sql",
    "0037_neuron_capture_batch_receipts.sql",
  ]) {
    const source = readFileSync(
      new URL(`../migrations/d1/${name}`, import.meta.url),
      "utf8",
    );
    for (const sql of source.split("-- statement-breakpoint")) {
      if (sql.includes("subnet_snapshots_closed_day")) continue;
      if (sql.trim()) db.exec(sql);
    }
  }
  let reject: ((sql: string) => boolean) | undefined;
  const logical: number[] = [];
  const allocated: number[] = [];
  const active: number[] = [];
  function measure() {
    logical.push(
      families.reduce(
        (sum, family) =>
          sum +
          Number(
            db
              .prepare(
                `SELECT coalesce(sum(length(payload)),0) n FROM ${family}_documents`,
              )
              .get()!.n,
          ),
        0,
      ),
    );
    const pages = Number(db.prepare("PRAGMA page_count").get()!.page_count);
    const free = Number(db.prepare("PRAGMA freelist_count").get()!.freelist_count);
    const size = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    allocated.push(pages * size);
    active.push((pages - free) * size);
  }
  function prepared(text: string, values: unknown[] = []) {
    return {
      text,
      values,
      bind: (...args: unknown[]) => prepared(text, args),
      async all() {
        return {
          results: db.prepare(text).all(...(values as never[])),
          meta: { duration: 0 },
        };
      },
    };
  }
  const binding = {
    prepare: prepared,
    async batch(items: ReturnType<typeof prepared>[]) {
      db.exec("BEGIN");
      try {
        const result = items.map(({ text, values }) => {
          if (reject?.(text)) throw new Error("injected later failure");
          const changes = db.prepare(text).run(...(values as never[])).changes;
          measure();
          return { meta: { changes: Number(changes), duration: 0 } };
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1StoreBinding;
  const native = createD1Store(binding, families);
  const store = previous
    ? {
        ...native,
        transaction: (statements: readonly ProducerStatement[]) =>
          native.transaction(previousOrder(statements)),
      }
    : native;
  return {
    db,
    write: (input: NeuronMirrorInput) => writeNeuronDocuments(store, input),
    reject: (predicate?: typeof reject) => (reject = predicate),
    reset: () => {
      logical.length = allocated.length = active.length = 0;
      measure();
    },
    peak: () => ({
      documentBytes: Math.max(...logical),
      allocatedBytes: Math.max(...allocated),
      activePageBytes: Math.max(...active),
    }),
    snapshot: () =>
      tables.map((table) => ({
        table,
        rows: db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      })),
  };
}

test("history follows final current pruning without changing any statement or binding", () => {
  const input = capture([row(0, stamp + 1000)]);
  const statements = neuronDocumentStatements(input);
  const prune = statements.findIndex(isPrune);
  const history = statements.findIndex((s) =>
    s.text.startsWith("INSERT INTO neuron_daily_documents"),
  );
  assert.ok(prune >= 0 && prune + 1 < history);
  const prior = previousOrder(statements);
  assert.deepEqual(prior.filter(isPrune), statements.filter(isPrune));
  assert.equal(prior.length, statements.length);
  assert.deepEqual(
    prior.filter((s) => !isPrune(s)),
    statements.filter((s) => !isPrune(s)),
  );
});

test("mixed timestamps, untouched netuids, stale-only shards, daily histories and retries remain equivalent", async () => {
  const before = fixture(true);
  const after = fixture();
  const seed = capture([
    row(0),
    row(2, stamp + 2000),
    row(256),
    row(257, stamp + 3000),
    row(512),
    row(0, stamp + 5000, 2),
  ]);
  seed.netuidMaxCapturedAt = null;
  const incoming = capture([
    { ...row(0, stamp + 2000), hotkey: 'reused"\\é' },
    row(1, stamp + 2000),
    { ...row(2, stamp + 2000), hotkey: "equal-ignored" },
    row(257, stamp + 1000),
    row(513, stamp + 1000),
  ]);
  incoming.pass = {
    capturedAt: stamp + 2000,
    expectedRows: 5,
    receivedRows: 5,
    nowMs: stamp + 10_000,
  };
  for (const input of [seed, incoming, incoming]) {
    await before.write(input);
    await after.write(input);
    assert.deepEqual(after.snapshot(), before.snapshot());
    if (input === seed) {
      assert.equal(
        after.db.prepare("SELECT count(*) n FROM neurons").get()!.n,
        6,
      );
      for (const f of [before, after]) {
        f.db.exec("CREATE TABLE member_changes(kind TEXT,netuid INTEGER,uid INTEGER)");
        for (const kind of ["INSERT", "UPDATE", "DELETE"]) {
          const value = kind === "DELETE" ? "OLD" : "NEW";
          f.db.exec(
            `CREATE TRIGGER member_${kind} AFTER ${kind} ON neurons_members BEGIN
            INSERT INTO member_changes VALUES('${kind}',${value}.netuid,${value}.uid); END`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    after.db.prepare("SELECT * FROM member_changes ORDER BY 1,2,3").all(),
    before.db.prepare("SELECT * FROM member_changes ORDER BY 1,2,3").all(),
  );
  assert.equal(
    after.db
      .prepare(
        "SELECT count(*) n FROM member_changes WHERE uid IN (2,257) OR netuid=2",
      )
      .get()!.n,
    0,
  );
  assert.deepEqual(
    after.db
      .prepare("SELECT netuid,uid,captured_at FROM neurons ORDER BY 1,2")
      .all()
      .map((value) => ({ ...value })),
    [
      { netuid: 1, uid: 0, captured_at: stamp + 2000 },
      { netuid: 1, uid: 1, captured_at: stamp + 2000 },
      { netuid: 1, uid: 2, captured_at: stamp + 2000 },
      { netuid: 1, uid: 257, captured_at: stamp + 3000 },
      { netuid: 2, uid: 0, captured_at: stamp + 5000 },
    ],
  );
  assert.equal(
    after.db.prepare("SELECT received_rows FROM neurons_passes").get()!.received_rows,
    5,
  );
  assert.equal(
    after.db
      .prepare(
        "SELECT count(*) n FROM account_position_daily WHERE account IN ('key-1-0',?)",
      )
      .get('reused"\\é')!.n,
    2,
  );
});

for (const failure of [
  "INSERT INTO neuron_daily_documents",
  "INSERT INTO account_position_daily_documents",
  "INSERT INTO neurons_passes",
  "INSERT INTO archive_export_revisions",
]) {
  test(`later failure rolls back current pruning and all history: ${failure}`, async () => {
    const f = fixture();
    await f.write(capture([row(0), row(512)]));
    const original = f.snapshot();
    f.reject((sql) => sql.startsWith(failure));
    const input = capture([row(0, stamp + 1000)]);
    input.pass = {
      capturedAt: stamp + 1000,
      expectedRows: 1,
      receivedRows: 1,
      nowMs: stamp + 2000,
    };
    await assert.rejects(f.write(input), /injected later failure/);
    assert.deepEqual(f.snapshot(), original);
  });
}

test("replacement reduces fixture document peak before new-day history; no-cutoff schedule is unchanged", async () => {
  const before = fixture(true);
  const after = fixture();
  const seed = capture(
    Array.from({ length: 256 }, (_, uid) => ({
      ...row(uid),
      axon: "x".repeat(512),
    })),
  );
  const incoming = capture(
    Array.from({ length: 256 }, (_, uid) => ({
      ...row(uid + 256, stamp + 86_400_000),
      axon: "y".repeat(512),
    })),
  );
  for (const f of [before, after]) {
    await f.write(seed);
    f.reset();
    await f.write(incoming);
  }
  assert.deepEqual(after.snapshot(), before.snapshot());
  assert.ok(after.peak().documentBytes < before.peak().documentBytes);
  // Physical page observations are fixture diagnostics, never a D1 recovery guarantee.
  console.log("neuron snapshot ordering fixture", {
    before: before.peak(),
    after: after.peak(),
  });
  const noCutoff = { ...incoming, netuidMaxCapturedAt: null };
  assert.deepEqual(
    previousOrder(neuronDocumentStatements(noCutoff)),
    neuronDocumentStatements(noCutoff),
  );
});
