import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { PGlite } from "@electric-sql/pglite";
import { createD1Store } from "../src/d1-store.ts";
import {
  axonSequenceD1Sql,
  AXON_DAY_COUNTS_D1_SQL,
} from "../src/axon-transition-d1.ts";
import { isRoutableAxon, splitAxon } from "../src/axon-routable.ts";
import { loadAxonRemovals } from "../src/axon-removals-loader.ts";
import {
  deriveAxonRemovals,
  type NeuronAxonDayRow,
} from "../src/axon-removal-derivation.ts";
import {
  loadAxonLossMechanisms,
  runAxonAnnouncementWatchdog,
} from "../src/axon-announcement-watchdog.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import { apiEnv } from "./helpers/worker-env.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const pg = new PGlite();
const now = Date.parse("2026-08-04T12:00:00Z");
const env = () =>
  apiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: "neuron_daily",
    HYPERDRIVE: undefined,
  });
const query = async (sql: string, values: unknown[]) =>
  (await pg.query(toPositionalPlaceholders(sql), values)).rows;
const series: [number, (string | null)[], string[]?][] = [
  [1, ["1.2.3.4:8091", null, null]],
  [2, ["5.6.7.8:8091", "192.0.2.1:8091", "192.0.2.1:8091"]],
  [3, ["9.9.9.9:8091", null, "9.9.9.9:8091"]],
  [4, ["8.8.8.8:8091", null, null], ["old", "new", "new"]],
  [5, ["4.4.4.4:8091", null]],
  [6, ["1.1.1.1:8091", "1.1.1.1:8091", "1.1.1.1:8091"]],
  [7, ["10.0.0.5:8091", null, null]],
  [8, ["2607:fb90:1036:1:8091", "FE80::1:8091", "FE80::1:8091"]],
];
const rows = series.flatMap(([uid, axons, hotkeys]) =>
  axons.map((axon, i) => ({
    netuid: uid === 8 ? 8 : 7,
    uid,
    snapshot_date: `2026-08-0${i + 1}`,
    hotkey: hotkeys?.[i] ?? `hk${uid}`,
    axon,
  })),
);
async function seed(input: typeof rows) {
  const docs = new Map<
    string,
    {
      netuid: number;
      day: string;
      shard: number;
      payload: Record<string, unknown>;
    }
  >();
  for (const row of input) {
    const shard = Math.floor(row.uid / 256),
      key = `${row.netuid}/${row.snapshot_date}/${shard}`;
    const doc = docs.get(key) ?? {
      netuid: row.netuid,
      day: row.snapshot_date,
      shard,
      payload: {},
    };
    doc.payload[String(row.uid)] = row;
    docs.set(key, doc);
    await db
      .prepare(
        "INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,hotkey,shard) VALUES(?,?,?,?,?)",
      )
      .bind(row.netuid, row.uid, row.snapshot_date, row.hotkey, shard)
      .run();
    await pg.query("INSERT INTO neuron_daily VALUES($1,$2,$3,$4,$5)", [
      row.netuid,
      row.uid,
      row.snapshot_date,
      row.hotkey,
      row.axon,
    ]);
  }
  for (const doc of docs.values())
    await db
      .prepare("INSERT INTO neuron_daily_documents VALUES(?,?,?,?,jsonb(?))")
      .bind(doc.netuid, doc.day, doc.shard, now, JSON.stringify(doc.payload))
      .run();
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0007_neuron_documents.sql",
    "0012_neuron_daily_join_index.sql",
  ]) {
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  }
  await pg.exec(
    "CREATE TABLE neuron_daily(netuid integer,uid integer,snapshot_date text,hotkey text,axon text)",
  );
});
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM neuron_daily_documents"),
    db.prepare("DELETE FROM neuron_daily_members"),
  ]);
  await pg.exec("TRUNCATE neuron_daily");
});
afterAll(async () => {
  await runtime.dispose();
  await pg.close();
});

test("native document narrowing matches PostgreSQL and the full derivation including reused UIDs, pending and IPv6 moves", async () => {
  await seed(rows);
  const native = await loadAxonRemovals(env(), { now: () => now });
  const postgres = await loadAxonRemovals({}, { query, now: () => now });
  assert.deepEqual(native, postgres);
  assert.deepEqual(
    native?.derivation,
    deriveAxonRemovals(rows, { lookbackDays: 30 }).derivation,
  );
  assert.equal(native?.removals.length, 3);
  const scoped = await loadAxonRemovals(env(), { now: () => now, netuid: 8 });
  assert.deepEqual(
    scoped?.removals,
    native?.removals.filter((row) => row.netuid === 8),
  );
  assert.equal(scoped?.subnets.length, 1);
  assert.equal(native?.derivation.excluded_uid_reuse, 1);
  assert.equal(native?.derivation.pending_confirmation, 1);
  assert.equal(native?.derivation.moved_unroutable, 2);
  assert.deepEqual(
    (
      await createD1Store(db).query<NeuronAxonDayRow>(
        axonSequenceD1Sql("AND d.netuid IN (?)"),
        ["2026-08-02", 8],
      )
    ).map((r) => r.snapshot_date),
    ["2026-08-02", "2026-08-03"],
  );
});

test("D1 classification shares every address boundary and the last-colon split, including escaped text", async () => {
  const axons: (string | null)[] = [
    null,
    "",
    ":8091",
    "8.8.8.8",
    "::1:8091",
    ":::8091",
    "2001:db8::1:8091",
    "FC01::1:8091",
    "fd00::1:8091",
    "FE80::1:8091",
    "FeB0::1:8091",
    "fec0::1:8091",
    "fe70::1:8091",
    'quoted"host:abc',
    "back\\slash:abc",
  ];
  for (const prefix of [
    "0.",
    "10.",
    "127.",
    "192.168.",
    "192.0.2.",
    "198.51.100.",
    "203.0.113.",
  ])
    axons.push(`${prefix}1:8091`);
  for (let second = 0; second < 256; second++)
    axons.push(`172.${second}.0.1:8091`);
  await seed(
    axons.map((axon, uid) => ({
      netuid: 7,
      uid,
      snapshot_date: "2026-08-01",
      hotkey: `hk${uid}`,
      axon,
    })),
  );
  const actual = await createD1Store(db).query<{
    uid: number;
    routable: number;
    prev_address: string | null;
  }>(axonSequenceD1Sql(), ["2026-08-01"]);
  assert.equal(actual.length, axons.length);
  for (const row of actual)
    assert.equal(
      Boolean(row.routable),
      isRoutableAxon(axons[row.uid]),
      String(axons[row.uid]),
    );
  // Read the lagged address to prove it is the exact shared split, not merely a classification match.
  await seed(
    axons.map((axon, uid) => ({
      netuid: 7,
      uid,
      snapshot_date: "2026-08-02",
      hotkey: `hk${uid}`,
      axon,
    })),
  );
  const withLag = await createD1Store(db).query<{
    uid: number;
    prev_address: string | null;
    snapshot_date: string;
  }>(axonSequenceD1Sql(), ["2026-08-01"]);
  for (const row of withLag.filter((r) => r.snapshot_date === "2026-08-02"))
    assert.equal(
      row.prev_address,
      axons[row.uid] === null ? null : splitAxon(axons[row.uid]!).address,
    );
});

test("watchdog native counts and mechanism attribution agree with PostgreSQL and execute without Hyperdrive", async () => {
  await seed(rows);
  const native = await loadAxonLossMechanisms(
    createD1Store(db),
    [7, 8],
    "2026-08-01",
    true,
  );
  const postgres = await loadAxonLossMechanisms(
    { query: (sql, values = []) => query(sql, values) },
    [7, 8],
    "2026-08-01",
  );
  assert.deepEqual(native, postgres);
  assert.equal(native[8]?.distinctIps, 1);
  const days = await createD1Store(db).query<{
    netuid: number;
    date: string;
    neurons: number;
    with_axon: number;
  }>(AXON_DAY_COUNTS_D1_SQL, ["2026-08-01"]);
  for (const day of days) {
    const members = rows.filter(
      (r) => r.netuid === day.netuid && r.snapshot_date === day.date,
    );
    assert.equal(day.neurons, members.length);
    assert.equal(
      day.with_axon,
      members.filter((r) => isRoutableAxon(r.axon)).length,
    );
  }
  const tick = await runAxonAnnouncementWatchdog(env(), {
    now: () => now,
    recordException: async () => true,
  });
  assert.equal(tick.ok, true);
});

test("bounded document plan point-looks up each day member and excludes a stale document-only row", async () => {
  await seed(rows);
  await db
    .prepare(
      "UPDATE neuron_daily_documents SET payload=jsonb_set(payload,'$.99',jsonb(?)) WHERE netuid=7",
    )
    .bind(JSON.stringify({ uid: 99, hotkey: "stale", axon: "8.8.8.8:8091" }))
    .run();
  const store = createD1Store(db);
  const actual = await store.query<{ uid: number }>(axonSequenceD1Sql(), [
    "2026-08-01",
  ]);
  assert.equal(actual.length, rows.length);
  assert.equal(
    actual.some((r) => r.uid === 99),
    false,
  );
  const plan = await store.query<{ detail: string }>(
    "EXPLAIN QUERY PLAN " + axonSequenceD1Sql(),
    ["2026-08-01"],
  );
  const membership = plan
    .filter((r) => r.detail.startsWith("SEARCH m "))
    .map((r) => r.detail)
    .join("\n");
  assert.match(membership, /snapshot_date=\?/);
  assert.doesNotMatch(membership, /snapshot_date>\?/);
});
