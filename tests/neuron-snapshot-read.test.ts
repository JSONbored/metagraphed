import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Sql, createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import { readNeuronDirectoryRows } from "../src/neuron-snapshot-read.ts";
import type { PgSql } from "../src/pg-sql.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = 1790090000000;
const unexpectedSql = {
  unsafe() {
    throw new Error("Must not read the old store");
  },
} as unknown as PgSql;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL("../migrations/d1/0007_neuron_documents.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
  const rows = [0, 7, 128].flatMap((netuid) =>
    Array.from({ length: 258 }, (_, uid) => ({
      netuid,
      uid,
      hotkey: uid === 4 ? null : `5${uid % 7}`,
      coldkey: uid % 2 ? "5Cold" : null,
      validator_permit: uid % 3 === 0,
      validator_trust: uid / 1000,
      emission_tao: uid / 1000000000,
      stake_tao: uid % 4 ? (uid % 5) + 0.000000001 : null,
      block_number: 9123456 + netuid,
      captured_at: stamp + netuid,
      take: uid % 2 ? 0.1 : null,
    })),
  );
  await writeNeuronDocuments(createD1Store(db), {
    ...neuronSnapshotWrite(rows, stamp + 1000),
    dailyRows: [],
    positionRows: [],
  });
  // Identity comes from the member index, not stale identifiers in a document.
  await db
    .prepare("UPDATE neurons_members SET hotkey='5Changed' WHERE uid=0")
    .run();
  // Orphan documents and mis-sharded members must not reintroduce registrations.
  await db.prepare("DELETE FROM neurons_members WHERE uid=8").run();
  await db.prepare("UPDATE neurons_members SET shard=99 WHERE uid=9").run();
});
afterAll(() => runtime.dispose());

test.each([false, true])(
  "native snapshot is exactly the indexed-view result, validatorsOnly=%s",
  async (validatorsOnly) => {
    const portable = createD1Sql(createD1Store(db));
    const expected = await readNeuronDirectoryRows(
      portable,
      {},
      validatorsOnly,
    );
    const statements: string[] = [];
    const binding = {
      prepare(sql: string) {
        statements.push(sql);
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const actual = await readNeuronDirectoryRows(
      unexpectedSql,
      { D1_STATE: binding, D1_STATE_TABLES: "neurons" },
      validatorsOnly,
    );
    assert.deepEqual(actual, expected);
    assert.ok(actual.length > 200);
    assert.ok(actual.some((row) => row.hotkey === "5Changed"));
    assert.ok(
      actual.every((row) => row.uid !== 4 && row.uid !== 8 && row.uid !== 9),
    );
    assert.equal(statements.length, 1);
    const plan = (
      await db
        .prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
    assert.match(plan[0], /^SCAN d/);
    assert.match(plan[1], /^SCAN j VIRTUAL TABLE/);
    assert.match(
      plan[2],
      /^SEARCH m USING PRIMARY KEY \(netuid=\? AND uid=\?\)/,
    );
    assert.equal(plan.filter((step) => step.includes("SCAN d")).length, 1);
  },
);

test("the default reads all accounts and absent selected storage cannot fall back", async () => {
  const environment = { D1_STATE: db, D1_STATE_TABLES: "neurons" };
  assert.deepEqual(
    await readNeuronDirectoryRows(unexpectedSql, environment),
    await readNeuronDirectoryRows(unexpectedSql, environment, false),
  );
  await assert.rejects(
    readNeuronDirectoryRows(unexpectedSql, { D1_STATE_TABLES: "neurons" }),
    /Selected D1 store is unbound/,
  );
  await assert.rejects(
    readNeuronDirectoryRows(unexpectedSql, {}),
    /Must not read the old store/,
  );
});

test("an empty native snapshot is empty for both directories", async () => {
  const emptyDb = await runtime.getD1Database("DB");
  await emptyDb.prepare("DELETE FROM neurons_members").run();
  for (const validatorsOnly of [false, true]) {
    assert.deepEqual(
      await readNeuronDirectoryRows(
        unexpectedSql,
        { D1_STATE: emptyDb, D1_STATE_TABLES: "neurons" },
        validatorsOnly,
      ),
      [],
    );
  }
});
