import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { Miniflare } from "miniflare";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["BEFORE", "AFTER"],
});
let before: D1Database;
let after: D1Database;
const day = "2026-09-22";
const stamp = 1790090000000;
async function migration(db: D1Database, name: string) {
  const source = readFileSync(
    new URL(`../migrations/d1/${name}`, import.meta.url),
    "utf8",
  );
  for (const sql of source.split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
}
beforeAll(async () => {
  before = await runtime.getD1Database("BEFORE");
  after = await runtime.getD1Database("AFTER");
  for (const db of [before, after])
    for (const name of [
      "0007_neuron_documents.sql",
      "0012_neuron_daily_join_index.sql",
      "0020_neuron_axon_projection.sql",
      "0030_neuron_axon_insert_projection.sql",
    ])
      await migration(db, name);
  await migration(after, "0031_neuron_axon_document_projection.sql");
});
beforeEach(async () => {
  for (const db of [before, after]) {
    await db.prepare("DELETE FROM neuron_daily_members").run();
    await db.prepare("DELETE FROM neuron_daily_documents").run();
  }
});
afterAll(async () => {
  await runtime.dispose();
});

async function seed(db: D1Database, count: number) {
  const members = Array.from({ length: 10 }, (_, offset) =>
    Array.from({ length: count }, (_, uid) => ({
      netuid: offset === 9 ? 2 : 1,
      uid,
      day:
        offset === 9 ? day : `2026-09-${String(22 - offset).padStart(2, "0")}`,
      shard: Math.floor(uid / 256),
    })),
  ).flat();
  await db
    .prepare(
      `INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,shard,axon_index,axon_indexed)
    SELECT json_extract(value,'$.netuid'),json_extract(value,'$.uid'),json_extract(value,'$.day'),
      json_extract(value,'$.shard'),'untouched',1 FROM json_each(?)`,
    )
    .bind(JSON.stringify(members))
    .run();
}
const projection = async (db: D1Database) =>
  (
    await db
      .prepare(
        "SELECT netuid,uid,snapshot_date,shard,axon_index,axon_indexed FROM neuron_daily_members ORDER BY netuid,uid,snapshot_date",
      )
      .all()
  ).results;
const insert = (db: D1Database, payload: string) =>
  db
    .prepare(
      "INSERT INTO neuron_daily_documents(netuid,day,shard,stamp,payload) VALUES(1,?,0,?,jsonb(?))",
    )
    .bind(day, stamp, payload)
    .run();
const update = (db: D1Database, payload: string) =>
  db
    .prepare(
      "UPDATE neuron_daily_documents SET payload=jsonb(?) WHERE netuid=1 AND day=? AND shard=0",
    )
    .bind(payload, day)
    .run();

test("document corrections preserve every axon and scope while expanding a populated shard once", async () => {
  const initial = Object.fromEntries(
    Array.from({ length: 256 }, (_, uid) => [
      String(uid),
      {
        axon: uid % 3 ? "1.2.3.4:8091" : null,
        captured_at: stamp,
        payload: "x".repeat(768),
      },
    ]),
  );
  const changed = Object.fromEntries(
    Object.entries(initial)
      .filter(([key]) => key !== "7")
      .map(([key, row]) => [
        key,
        { ...row, axon: Number(key) % 8 ? row.axon : "8.8.8.8:8091" },
      ]),
  );
  const metrics: Record<string, unknown> = {};
  const results: unknown[][] = [];
  for (const [label, db] of [
    ["before", before],
    ["after", after],
  ] as const) {
    await seed(db, 512);
    const inserted = await insert(db, JSON.stringify(initial));
    const changedResult = await update(db, JSON.stringify(changed));
    const repeated = await update(db, JSON.stringify(changed));
    // A pending index must be repaired even when its existing axon matches.
    await db
      .prepare(
        "UPDATE neuron_daily_members SET axon_indexed=0 WHERE netuid=1 AND uid=0 AND snapshot_date=?",
      )
      .bind(day)
      .run();
    await update(db, JSON.stringify(changed));
    const rows = await projection(db);
    results.push(rows);
    assert.equal(rows.length, 5120);
    const target = rows.filter(
      (r) => r.netuid === 1 && r.snapshot_date === day && r.shard === 0,
    );
    assert.equal(target.length, 256);
    assert.ok(target.every((r) => r.axon_indexed === 1));
    assert.equal(target.find((r) => r.uid === 7)?.axon_index, null);
    assert.ok(
      rows
        .filter(
          (r) => r.netuid !== 1 || r.snapshot_date !== day || r.shard !== 0,
        )
        .every((r) => r.axon_index === "untouched"),
    );
    metrics[label] = Object.fromEntries(
      Object.entries({ inserted, changed: changedResult, repeated }).map(
        ([name, r]) => [
          name,
          {
            ms: r.meta.duration,
            reads: r.meta.rows_read,
            writes: r.meta.rows_written,
          },
        ],
      ),
    );
    // The repeated payload changes the document itself but no indexed member.
    assert.equal(repeated.meta.changes, 1);
  }
  assert.deepEqual(results[1], results[0]);
  console.log("axon document trigger qualification", JSON.stringify(metrics));
});

test("legacy JSON duplicates, non-object members, absent keys and arrays retain path-lookup semantics", async () => {
  const cases = [
    '{"0":{"axon":"first"},"0":{"axon":"second"},"1":"text","01":{"axon":"wrong-key"},"2":null,"3":{"axon":false},"4":{"axon":42},"5":{}}',
    '[{"axon":"array-zero"},{"axon":"array-one"}]',
    '{"0":{"axon":null},"1":{"axon":"new"},"2":{"axon":"restored"}}',
  ];
  for (const db of [before, after]) {
    await seed(db, 8);
    await insert(db, "{}");
  }
  for (const payload of cases) {
    await update(before, payload);
    await update(after, payload);
    assert.deepEqual(await projection(after), await projection(before));
  }
});
