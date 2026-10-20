import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { Miniflare, NoOpLog } from "miniflare";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";
import { prepareRawCapture, encodeRawCaptureIntent, rawCaptureIntentKey } from "../src/raw-capture-retry-intent.ts";

let runtime: Miniflare | undefined;
function setupStage(stage: string, migration = -1, statement = -1) {
  if (process.env.RAW_CAPTURE_QUALIFY_DIAGNOSTICS === "1")
    writeFileSync("raw-capture-retry-reports/native-setup.json", JSON.stringify({stage,migration,statement}));
}
setupStage("fixture_loaded");
let native: D1Database;
const key = "chain/raw/blocks/000000000010-000000000010.ndjson";
const value = (at = 1000, body = "0x00", height = 10) => JSON.stringify({
  block_number: height, block_hash: "0x123", parent_hash: "0x122",
  header: {digest:{logs:[]}}, extrinsics: [body], events: null, captured_at: at,
}) + "\n";
type Hook = (sql: string) => void | Promise<void>;
function adapter(before?: Hook, after?: Hook) {
  const original = new WeakMap<object, D1PreparedStatement>();
  const wrap = (sql: string, raw: D1PreparedStatement) => {
    const statement = {
      bind(...values: unknown[]) { return wrap(sql, raw.bind(...values)); },
      async first<T>(column?: string) { await before?.(sql); return column === undefined ? raw.first<T>() : raw.first<T>(column); },
      async all<T>() { await before?.(sql); return raw.all<T>(); },
      async run<T>() { await before?.(sql); const result = await raw.run<T>(); await after?.(sql); return result; },
    };
    original.set(statement, raw);
    return statement;
  };
  return {
    prepare(sql: string) { return wrap(sql, native.prepare(sql)); },
    async batch(statements: object[]) {
      const raw = statements.map((statement) => {
        const found = original.get(statement);
        assert(found);
        return found;
      });
      const result = await native.batch(raw);
      await after?.("UPDATE raw_capture_batches\ncompletion");
      return result;
    },
  } as unknown as Pick<D1Database,"prepare"|"batch">;
}
async function control() {
  return native.prepare("SELECT payload FROM generated_artifacts WHERE key=?")
    .bind(rawCaptureIntentKey("mainnet")).first<string>("payload");
}
async function count(table: "raw_capture_batches" | "raw_capture_chunks" | "generated_artifacts") {
  return native.prepare("SELECT count(*) n FROM " + table).first<number>("n");
}
async function compressed(sha: string) {
  const d = await native.prepare("SELECT parts FROM raw_capture_batches WHERE key=? AND sha256=?").bind(key, sha).first<{parts:number}>();
  assert(d);
  const chunks: Buffer[] = [];
  for (let start = 0; start < d.parts; start += 8) {
    const rows = await native.prepare("SELECT part,hex(data) data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part>=? AND part<? ORDER BY part")
      .bind(key, sha, start, start+8).all<{part:number;data:string}>();
    for (const row of rows.results) chunks.push(Buffer.from(row.data,"hex"));
  }
  return Buffer.concat(chunks);
}
beforeAll(async () => {
  setupStage("runtime_construct");
  runtime = new Miniflare({
    log: new NoOpLog(),
    modules: true,
    script: "export default {fetch(){return new Response('synthetic fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  setupStage("database");
  native = await runtime.getD1Database("DB") as unknown as D1Database;
  for (const [migration,path] of ["0027_generated_artifacts.sql","0028_raw_capture_storage.sql","0029_raw_capture_archive.sql"].entries()) {
    setupStage("migration_read",migration);
    const sql = readFileSync(new URL("../migrations/d1/"+path,import.meta.url),"utf8");
    for (const [ordinal,statement] of sql.split(/(?=^(?:CREATE (?:TABLE|TRIGGER|INDEX)|INSERT INTO))/m).entries())
      if (/^(?:CREATE|INSERT)/.test(statement.trim())) {
        setupStage("migration_statement",migration,ordinal);
        await native.prepare(statement).run();
      }
  }
  setupStage("state_read");
  const schema = readFileSync(new URL("../db/d1-schema.sql",import.meta.url),"utf8");
  const watermark = /CREATE TABLE raw_capture_state[\s\S]*?;/.exec(schema);
  assert(watermark);
  setupStage("state_statement");
  await native.prepare(watermark[0]).run();
  setupStage("ready");
});
beforeEach(async () => {
  for (const table of ["raw_capture_selected","raw_capture_archives","raw_capture_batches","generated_artifacts","raw_capture_state"])
    await native.prepare("DELETE FROM "+table).run();
  await native.prepare("INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('mainnet',9,1000)").run();
  assert.equal(await native.prepare("SELECT objects FROM raw_capture_budget").first<number>("objects"),0);
});
afterAll(async () => { await runtime?.dispose(); });

test("native D1 fresh provenance resumes exact original after partial failure and recreation", async () => {
  const body = randomBytes(900_000).toString("hex");
  const original = value(1000, body);
  let windows=0;
  const db = adapter((sql) => {
    if (sql.startsWith("INSERT INTO raw_capture_chunks") && ++windows===2)
      throw new Error("synthetic persistent second window");
  });
  await assert.rejects(rawCaptureD1(db).put(key,original),/second window/);
  assert.equal(await count("raw_capture_batches"),1);
  assert.equal(await count("raw_capture_chunks"),8);
  const pinned=await control();
  await rawCaptureD1(adapter()).put(key,value(2000,body));
  const sha=createHash("sha256").update(original).digest("hex");
  assert.equal(await native.prepare("SELECT sha256 FROM raw_capture_selected").first<string>("sha256"),sha);
  assert.equal(await count("raw_capture_batches"),1);
  assert.equal(await control(),pinned);
  assert.equal(gunzipSync(await compressed(sha)).toString(),original);
});

test("native D1 overlapping fresh writers keep one chosen descriptor and budget", async () => {
  const db=adapter();
  const receipts=await Promise.all([rawCaptureD1(db).put(key,value(1000)),rawCaptureD1(db).put(key,value(2000))]);
  assert.deepEqual(receipts[0],receipts[1]);
  assert.equal(await count("raw_capture_batches"),1);
  assert.equal(await native.prepare("SELECT objects FROM raw_capture_budget").first<number>("objects"),1);
  const payload=await control();
  assert(payload);
  const selected=JSON.parse(payload).descriptor.sha256;
  assert.equal(await native.prepare("SELECT sha256 FROM raw_capture_selected").first<string>("sha256"),selected);
});

test("native D1 same-length corruption preserves the intent after a committed watermark", async () => {
  const store=rawCaptureD1(adapter());
  const receipt=await store.put(key,value());
  const pinned=await control();
  await native.prepare("UPDATE raw_capture_state SET last_contiguous_block=10").run();
  await native.prepare("UPDATE raw_capture_chunks SET data=zeroblob(length(data))").run();
  await assert.rejects(store.acknowledgeWatermark!(key,receipt),/compressed source differs/);
  assert.equal(await control(),pinned);
  assert.equal(await count("raw_capture_batches"),1);
});

test("native D1 intent acquisition checks the actual watermark in its statement", async () => {
  const store=rawCaptureD1(adapter(async (sql) => {
    if (sql.includes("INSERT INTO generated_artifacts"))
      await native.prepare("UPDATE raw_capture_state SET last_contiguous_block=10").run();
  }));
  await assert.rejects(store.put(key,value()),/intent was not acquired/);
  assert.equal(await control(),null);
  assert.equal(await count("raw_capture_batches"),0);
});

test("native D1 committed watermark and lost control reply reconcile without new reservations", async () => {
  const plain=rawCaptureD1(adapter());
  const receipt=await plain.put(key,value());
  await native.prepare("UPDATE raw_capture_state SET last_contiguous_block=10").run();
  const pending=await rawCaptureD1(adapter()).pending!("mainnet");
  assert(pending);
  let lost=true;
  const interrupted=rawCaptureD1(adapter(undefined,(sql) => {
    if (sql.startsWith("DELETE FROM generated_artifacts") && lost) {
      lost=false; throw new Error("synthetic lost committed release");
    }
  }));
  await assert.rejects(interrupted.acknowledgeWatermark!(pending.key,pending.receipt),/lost committed release/);
  assert.equal(await control(),null);
  await plain.acknowledgeWatermark!(key,receipt);
  const replay=await plain.put(key,value());
  await plain.acknowledgeWatermark!(key,replay);
  assert.equal(await count("raw_capture_batches"),1);
  assert.equal(await control(),null);
});

test("native D1 release and late exact replay preserve a newer control identity", async () => {
  const plain=rawCaptureD1(adapter());
  const receipt=await plain.put(key,value());
  await native.prepare("UPDATE raw_capture_state SET last_contiguous_block=10").run();
  const nextKey=key.replaceAll("000000000010","000000000011");
  const next=encodeRawCaptureIntent(prepareRawCapture(nextKey,value(2000,"0x00",11)));
  const release=rawCaptureD1(adapter(undefined,async (sql) => {
    if (sql.startsWith("DELETE FROM generated_artifacts"))
      await native.prepare("INSERT INTO generated_artifacts(key,payload) VALUES(?,?)")
        .bind(rawCaptureIntentKey("mainnet"),next).run();
  }));
  await release.acknowledgeWatermark!(key,receipt);
  const replay=await plain.put(key,value());
  await plain.acknowledgeWatermark!(key,replay);
  assert.equal(await control(),next);
  await assert.rejects(plain.put(key,value(2000)),/already acknowledged/);
  assert.equal(await control(),next);
  assert.equal(await count("raw_capture_batches"),1);
});

