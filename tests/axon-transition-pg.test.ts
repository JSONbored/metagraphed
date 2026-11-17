// The native axon-transition readings (#13019 slice 2), proven over a real
// PostgreSQL engine (PGlite) with hand-seeded composed-tree rows -- no decoder
// involved, so this suite runs everywhere. What it pins: the tagged text
// unwrap, the projected (receipts-twin) readings with duplicate-key fan-out,
// sequence transition semantics identical to the shared definition, day
// counts, projection readiness, non-text refusals by name, and mechid-0
// scoping on every read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, test } from "vitest";
import {
  axonSequencePgSql,
  axonDayCountsPgSql,
  createPgAxonTransition,
} from "../src/axon-transition-pg.ts";
import { AXON_LOSS_SQL } from "../src/axon-transition.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

let db: PGlite;
const store = () =>
  createPgAxonTransition({
    read: {
      async query<Row>(text: string, values: unknown[] = []) {
        return (await db.query<Row>(text, values)).rows;
      },
      async first() {
        return null;
      },
    },
  } as never);
const run = (sql: string, values: unknown[] = []) =>
  db.query(toPositionalPlaceholders(sql), values);

beforeAll(async () => {
  db = new PGlite();
  for (const name of ["0024_neuron_documents.sql", "0044_mechanisms.sql"])
    await db.exec(
      readFileSync(
        new URL(`../migrations/postgres/${name}`, import.meta.url),
        "utf8",
      ),
    );
  const member = async (
    uid: number,
    day: string,
    axon: string | null,
    indexed = true,
    hotkey = "5H",
  ) =>
    db.query(
      `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
       VALUES (1,0,$1,$2,$3,'5C',0,$4,$5)`,
      [
        uid,
        day,
        hotkey,
        axon === null ? null : JSON.stringify(["text", JSON.stringify(axon)]),
        indexed,
      ],
    );
  // uid 0: routable -> unroutable (documentation space) = one loss.
  await member(0, "2026-11-01", "8.8.8.8:8080");
  await member(0, "2026-11-02", "192.0.2.1:8080");
  // uid 1: IPv6 with port stays routable both days (no loss).
  await member(1, "2026-11-01", "[2606:4700::1111]:443");
  await member(1, "2026-11-02", "[2606:4700::1111]:443");
  // uid 2: hotkey handover (reuse family, not same-hotkey).
  await member(2, "2026-11-01", "1.1.1.1:1", true, "5OLD");
  await member(2, "2026-11-02", null, true, "5NEW");
  // A mechid-1 row that must be INVISIBLE to every reading.
  await db.query(
    `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
     VALUES (1,1,0,'2026-11-02','5MECH','5C',0,$1,true)`,
    [JSON.stringify(["text", JSON.stringify("203.0.113.9:1")])],
  );
  // The receipts twin for the unindexed path: duplicate uid key fans out.
  await db.query(
    `INSERT INTO app.neuron_document_projections(source_table,netuid,day,shard,payload_sha256,payload_json,decode_status,axon_values,decoder_version,decoder_source_id)
     VALUES ('neuron_daily_documents',1,'2026-11-01',0,$1,$2,'complete','[]','3.53.4',
       '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc')`,
    [
      new Uint8Array(32),
      '{"0":{"axon":"8.8.8.8:8080"},"0":{"axon":"192.0.2.1:1"},"1":{"axon":"[2606:4700::1111]:443"}}',
    ],
  );
});
afterAll(() => db.close());

test("the indexed sequence sees only the mechid-0 plane and keeps the shared transition semantics", async () => {
  const seq = (await run(
    `WITH seq AS (${axonSequencePgSql("", true)}) SELECT * FROM seq ORDER BY netuid,uid,snapshot_date`,
    ["2026-11-01"],
  )) as { rows: Record<string, unknown>[] };
  assert.equal(seq.rows.length, 6, "mechid-1 rows are invisible");
  const losses = (await run(
    `WITH seq AS (${axonSequencePgSql("", true)}) SELECT uid, prev_address FROM seq WHERE ${AXON_LOSS_SQL} ORDER BY uid`,
    ["2026-11-01"],
  )) as { rows: { uid: string | number; prev_address: string }[] };
  assert.deepEqual(
    losses.rows.map((row) => [Number(row.uid), row.prev_address]),
    [
      [0, "8.8.8.8"],
      [2, "1.1.1.1"],
    ],
    "one reachability loss and one handover loss, address split at the last colon",
  );
});

test("day counts aggregate routable vs total per subnet-day", async () => {
  const counts = (await run(axonDayCountsPgSql(true), ["2026-11-01"])) as {
    rows: {
      date: string;
      with_axon: string | number;
      neurons: string | number;
    }[];
  };
  assert.deepEqual(
    counts.rows.map((row) => [
      row.date,
      Number(row.with_axon),
      Number(row.neurons),
    ]),
    [
      ["2026-11-01", 3, 3],
      ["2026-11-02", 1, 3],
    ],
  );
});

test("the projected readings fan out duplicate keys exactly as the source json does", async () => {
  const seq = (await run(
    `WITH seq AS (${axonSequencePgSql("", false)}) SELECT uid, axon FROM seq ORDER BY uid, axon`,
    ["2026-11-01"],
  )) as { rows: { uid: string | number; axon: string }[] };
  assert.deepEqual(
    seq.rows.map((row) => [Number(row.uid), row.axon]),
    [
      [0, "192.0.2.1:1"],
      [0, "8.8.8.8:8080"],
      [1, "[2606:4700::1111]:443"],
    ],
    "both duplicate-key entries surface, joined to the mechid-0 member",
  );
});

test("projection readiness flips on the last unindexed mechid-0 row", async () => {
  assert.equal(await store().projectionReady(), true);
  await db.query(
    `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
     VALUES (1,0,9,'2026-11-03','5P','5C',0,NULL,false)`,
  );
  assert.equal(await store().projectionReady(), false);
  await db.query(
    "UPDATE app.neuron_daily_members SET axon_indexed=true WHERE uid=9",
  );
  assert.equal(await store().projectionReady(), true);
});

test("non-text readings refuse by name instead of coercing", async () => {
  await store().assertReadable(true);
  await store().assertReadable(false);
  await db.query(
    `INSERT INTO app.neuron_daily_members(netuid,mechid,uid,snapshot_date,hotkey,coldkey,shard,axon_index,axon_indexed)
     VALUES (1,0,8,'2026-11-03','5I','5C',0,$1,true)`,
    [JSON.stringify(["integer", "8080"])],
  );
  await assert.rejects(
    store().assertReadable(true),
    /non-text scalar.*integer/,
  );
  await db.query("DELETE FROM app.neuron_daily_members WHERE uid=8");
  await db.query(
    `INSERT INTO app.neuron_document_projections(source_table,netuid,day,shard,payload_sha256,payload_json,decode_status,axon_values,decoder_version,decoder_source_id)
     VALUES ('neuron_daily_documents',1,'2026-11-03',0,$1,'{"5":{"axon":8080}}','complete','[]','3.53.4',
       '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc')`,
    [new Uint8Array(32).fill(1)],
  );
  await assert.rejects(store().assertReadable(false), /non-text value.*number/);
});
