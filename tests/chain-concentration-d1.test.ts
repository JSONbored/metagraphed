import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import {
  pendingDaysSql,
  rollupChainConcentration,
} from "../src/chain-concentration-rollup.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const now = Date.UTC(2026, 8, 23, 12);
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const name of [
    "0007_neuron_documents.sql",
    "0012_neuron_daily_join_index.sql",
    "0022_neuron_document_dates.sql",
  ]) {
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${name}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  }
  await db
    .prepare(
      "CREATE TABLE chain_concentration_daily(day TEXT PRIMARY KEY,neuron_count INTEGER NOT NULL,card TEXT NOT NULL,source_captured_at INTEGER,computed_at INTEGER NOT NULL,builder_version INTEGER NOT NULL)",
    )
    .run();
  for (const day of [
    "2026-09-18",
    "2026-09-20",
    "2026-09-21",
    "2026-09-22",
    "2026-09-23",
  ]) {
    const stamp = Date.parse(`${day}T12:00:00Z`);
    const rows = [1, 7].flatMap((netuid) =>
      Array.from({ length: 258 }, (_, uid) => ({
        netuid,
        uid,
        hotkey: `5H${uid}`,
        coldkey: uid % 2 ? `5C${uid}` : null,
        validator_permit: uid % 3 === 0,
        emission_tao: uid / 1e9,
        stake_tao: uid % 7 ? uid / 10 : null,
        captured_at: stamp,
        block_number: 9000000 + uid,
      })),
    );
    const capture = neuronSnapshotWrite(rows, stamp);
    await writeNeuronDocuments(createD1Store(db), {
      ...capture,
      rows: [],
      positionRows: [],
    });
  }
  // Match the point view's membership semantics, including orphan documents.
  await db
    .prepare(
      "DELETE FROM neuron_daily_members WHERE snapshot_date='2026-09-18' OR uid=4",
    )
    .run();
  await db
    .prepare("UPDATE neuron_daily_members SET shard=99 WHERE uid=9")
    .run();
  await db
    .prepare("UPDATE neuron_daily_members SET coldkey='5Corrected' WHERE uid=0")
    .run();
});
afterAll(() => runtime.dispose());
test("native D1 document rollup preserves dates, membership rows and full cards", async () => {
  const statements: string[] = [];
  const store = createD1Store(db);
  const original = store.query;
  store.query = async (text, values) => {
    statements.push(text);
    return original(text, values);
  };
  const expectedDays = await original(pendingDaysSql(), ["2026-09-23", 3]);
  assert.deepEqual(
    await original(pendingDaysSql(true), ["2026-09-23", 3]),
    expectedDays,
  );
  const old = await rollupChainConcentration(store, { nowMs: now });
  const expected = await original(
    "SELECT * FROM chain_concentration_daily ORDER BY day",
  );
  await store.run("DELETE FROM chain_concentration_daily");
  statements.length = 0;
  const env = { D1_STATE: db, D1_STATE_TABLES: "neuron_daily" };
  const actual = await rollupChainConcentration(store, { nowMs: now, env });
  assert.deepEqual(actual, old);
  assert.deepEqual(
    await original("SELECT * FROM chain_concentration_daily ORDER BY day"),
    expected,
  );
  const read = statements.find((sql) => sql.includes("CROSS JOIN json_each"))!;
  assert.ok(read);
  const rows = await original(read, ["2026-09-22"]);
  const previous = await original(
    "SELECT stake_tao,emission_tao,coldkey,validator_permit,netuid,captured_at FROM neuron_daily WHERE snapshot_date=?",
    ["2026-09-22"],
  );
  const ordered = (values: unknown[]) =>
    values.map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(ordered(rows), ordered(previous));
  assert.equal(rows.length, 512);
  const discovery = await original(
    "EXPLAIN QUERY PLAN " + pendingDaysSql(true),
    ["2026-09-23", 3],
  );
  assert.match(
    JSON.stringify(discovery),
    /COVERING INDEX neuron_daily_documents_day_idx/,
  );
  assert.match(
    JSON.stringify(discovery),
    /COVERING INDEX neuron_daily_members_subnet_day_shard_idx/,
  );
  const expansion = await original("EXPLAIN QUERY PLAN " + read, [
    "2026-09-22",
  ]);
  assert.match(JSON.stringify(expansion), /neuron_daily_documents_day_idx/);
  assert.match(
    JSON.stringify(expansion),
    /SEARCH m USING COVERING INDEX neuron_daily_members_subnet_day_shard_idx/,
  );
  assert.equal(
    (await rollupChainConcentration(store, { nowMs: now, env })).rolled,
    false,
  );
});
