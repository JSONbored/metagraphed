import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { writeChainDetailD1 } from "../src/chain-detail-d1-write.ts";
import { parseChainDetailSync } from "../src/chain-detail-sync-payload.ts";
import { readChainDetailPayloadSnapshot } from "../src/chain-detail-payload-snapshot.ts";
import { pruneChainDetailPayloads } from "../src/chain-detail-payload-prune.ts";
import { restoreChainDetailPayloads } from "../src/chain-detail-payloads.ts";
import { loadExtrinsicHotTier, loadBlockChainEventsHotTier } from "../src/chain-detail-hot-tier.ts";
import { readHotHistoryTail, hotExtrinsicPredicate } from "../src/history-feed-hot-bridge.ts";
import { EXTRINSICS_COLUMNS } from "../generated/lakehouse/types.ts";

const runtime = new Miniflare({ modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06", d1Databases: ["DB", "RESTORED"] });
let db: D1Database, restored: D1Database;
const tables = ["chain_detail_blocks", "chain_detail_extrinsics", "chain_detail_chain_events", "chain_detail_account_events"];
const hash = `0x${"ab".repeat(32)}`;
const stamp = 1790090000000;
const raw = () => JSON.stringify({ blob: randomBytes(120000).toString("hex") });
const env = (binding = db) => ({ D1_STATE: binding, D1_STATE_TABLES: tables.join(","), CHAIN_DETAIL_PAYLOAD_GC: "enabled" });
function capture(value: string, block = 9000001) {
  const result = parseChainDetailSync({ blocks: [{ block_number: block, block_hash: hash,
    spec_version: 454, observed_at: stamp, extrinsics: [{ block_number: block,
      extrinsic_index: 0, extrinsic_hash: hash, signer: null, call_module: "Test",
      call_function: "payload", success: true, fee_tao: null, tip_tao: null,
      call_args: value, observed_at: stamp }], chain_events: [{ block_number: block,
      event_index: 0, pallet: "Test", method: "Payload", args: value,
      phase: "ApplyExtrinsic", extrinsic_index: 0, observed_at: stamp }], account_events: [] }] }, stamp);
  assert.ok(result.ok); return result.rows;
}
async function publish(value: string, block = 9000001) {
  const result = await writeChainDetailD1(createD1Store(db), env(), capture(value, block));
  assert.ok(Object.values(result).every((r) => r.ok));
}
async function state(binding = db) {
  const result = await binding.batch([
    binding.prepare("SELECT sha256,part,data FROM chain_detail_payload_chunks ORDER BY sha256,part"),
    binding.prepare("SELECT * FROM chain_detail_payload_budget WHERE id=1"),
  ]);
  const parts = result[0].results as {sha256:string;part:number;data:string}[];
  const budget = result[1].results[0] as {used_encoded_bytes:number;gc_after_sha256:string};
  assert.equal(budget.used_encoded_bytes, parts.reduce((sum,p) => sum+p.data.length,0));
  return {parts, budget};
}
async function retire() {
  await db.batch(tables.map((table) => db.prepare(`DELETE FROM ${table}`)));
}
async function sweep() { for (let n=0;n<3;n++) await pruneChainDetailPayloads(env()); }
beforeAll(async () => {
  db = await runtime.getD1Database("DB"); restored = await runtime.getD1Database("RESTORED");
  for (const binding of [db,restored]) {
    for (const file of ["migrations/d1/0014_recent_chain_state.sql", "migrations/d1/0024_chain_detail_payload_chunks.sql", "deploy/chain-detail-payloads/sqlite.sql"])
      for (const sql of readFileSync(new URL(`../${file}`,import.meta.url),"utf8").split("-- statement-breakpoint"))
        if (sql.trim()) await binding.prepare(sql).run();
    await binding.prepare("UPDATE chain_detail_payload_budget SET max_encoded_bytes=67108864").run();
  }
});
beforeEach(async () => {
  for (const binding of [db,restored]) {
    await binding.batch([...tables,"chain_detail_payload_chunks"].map((table) => binding.prepare(`DELETE FROM ${table}`)));
    await binding.prepare("UPDATE chain_detail_payload_budget SET gc_after_sha256='' WHERE id=1").run();
  }
});
afterAll(async () => runtime.dispose());

test("prepared reclamation captures immutable bytes before replacement or row pruning", async () => {
  const value = raw(); await publish(value);
  const snapshot = await readChainDetailPayloadSnapshot(env(), {text:"SELECT call_args FROM chain_detail_extrinsics"}, "call_args");
  assert.equal(snapshot.parts.size, 1);
  await publish(raw()); await retire(); await sweep();
  assert.equal((await state()).parts.length, 0);
  assert.deepEqual(await restoreChainDetailPayloads(env(), snapshot.rows, snapshot.parts), [{call_args:value}]);
  await assert.rejects(restoreChainDetailPayloads(env(), snapshot.rows, new Map()), /Missing native/);
});

test("prepared reclamation preserves either family reference and releases quota only after both retire", async () => {
  await publish(raw()); const original = await state();
  await db.prepare("DELETE FROM chain_detail_extrinsics").run(); await sweep();
  assert.deepEqual((await state()).parts, original.parts);
  await db.prepare("DELETE FROM chain_detail_chain_events").run(); await sweep();
  assert.equal((await state()).parts.length, 0);
  await publish(raw()); await retire();
  await pruneChainDetailPayloads({...env(), CHAIN_DETAIL_PAYLOAD_GC:undefined});
  assert.ok((await state()).parts.length > 0);
  await pruneChainDetailPayloads({CHAIN_DETAIL_PAYLOAD_GC:"enabled"});
  assert.ok((await state()).parts.length > 0);
});

test("prepared reclamation reader and indexed tail own bytes before a concurrent sweep", async () => {
  for (const mode of ["extrinsic","events","tail"] as const) {
    await retire(); await sweep(); await publish(raw());
    const read = (e: unknown) => mode === "extrinsic" ? loadExtrinsicHotTier(e,"9000001-0") : mode === "events"
      ? loadBlockChainEventsHotTier(e,9000001) : readHotHistoryTail(e,"extrinsics",9000000,9000001,"mainnet",EXTRINSICS_COLUMNS,hotExtrinsicPredicate({}),10);
    const original = await read(env()); assert.ok(original);
    let raced = false;
    const binding = { prepare: db.prepare.bind(db), async batch(statements: D1PreparedStatement[]) {
      const result = await db.batch(statements);
      if (!raced) { raced=true; await retire(); await sweep(); assert.equal((await state()).parts.length,0); }
      return result;
    } } as unknown as D1Database;
    assert.deepEqual(await read(env(binding)), original); assert.ok(raced);
  }
});

test("prepared reclamation serializes publication and failed cursor commits without losing shared parts", async () => {
  const value = raw(); await publish(value); await retire();
  const original = await state();
  await db.prepare("CREATE TRIGGER fixture_gc_abort BEFORE UPDATE ON chain_detail_payload_budget WHEN NEW.gc_after_sha256<>OLD.gc_after_sha256 BEGIN SELECT RAISE(ABORT,'fixture gc rollback'); END").run();
  await assert.rejects(pruneChainDetailPayloads(env()), /fixture gc rollback/);
  assert.deepEqual(await state(),original);
  await db.prepare("DROP TRIGGER fixture_gc_abort").run();
  let release!:()=>void; const gate = new Promise<void>((resolve) => { release=resolve; });
  let entered!:()=>void; const arrived = new Promise<void>((resolve) => { entered=resolve; });
  const binding = { prepare:db.prepare.bind(db), async batch(statements:D1PreparedStatement[]) {
    entered(); await gate; return db.batch(statements);
  } } as unknown as D1Database;
  const pending = pruneChainDetailPayloads(env(binding)); await arrived;
  await publish(value,9000002); release(); await pending;
  assert.deepEqual((await state()).parts, original.parts);
  await Promise.all(Array.from({length:8},() => pruneChainDetailPayloads(env())));
  assert.deepEqual((await state()).parts, original.parts);
});

test("prepared reclamation cycles through live prefixes and survives sustained replacement without quota growth", async () => {
  const values = Array.from({length:17},raw).sort((a,b) => createHash("sha256").update(a).digest("hex").localeCompare(createHash("sha256").update(b).digest("hex")));
  for (const [i,value] of values.entries()) await publish(value,9000001+i);
  for (const table of tables) await db.prepare(`DELETE FROM ${table} WHERE block_number=9000017`).run();
  await pruneChainDetailPayloads(env()); assert.equal((await state()).parts.length,17);
  await pruneChainDetailPayloads(env()); assert.equal((await state()).parts.length,16);
  await retire(); await sweep();
  for (let cycle=0;cycle<32;cycle++) {
    await publish(raw()); await sweep();
    const current = await state(); assert.equal(current.parts.length,1);
  }
});

test("prepared reclamation supplied cut restores source tables, chunks, quota and reader projections", async () => {
  await publish(raw()); await publish(raw(),9000002); await publish(raw()); await sweep();
  const owners = [...tables,"chain_detail_payload_chunks","chain_detail_payload_budget"];
  const snapshots = await db.batch(owners.map((name) => db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`)));
  const cut = Object.fromEntries(owners.map((name,i) => [name,snapshots[i].results]));
  const bytes = JSON.stringify(cut), pin=createHash("sha256").update(bytes).digest("hex");
  const original = await Promise.all([loadExtrinsicHotTier(env(),"9000001-0"),loadBlockChainEventsHotTier(env(),9000002)]);
  // This is a frozen supplied synthetic cut, not production writer fencing or custody.
  const directory=process.env.METAGRAPH_RECLAMATION_EVIDENCE;
  if (directory) { mkdirSync(directory,{recursive:true}); writeFileSync(path.join(directory,"cut-original.json"),bytes); writeFileSync(path.join(directory,"pins.json"),JSON.stringify({sha256:pin,source:process.env.GITHUB_SHA,production_common_cut:false,independent_custody:false})); }
  const copy=JSON.parse(bytes) as Record<string,Record<string,unknown>[]>;
  await restored.batch(owners.map((name) => restored.prepare(`DELETE FROM ${name}`)));
  // Restore the quota owner first with a derived zero counter; chunk triggers reconstruct it once.
  const budget=copy.chain_detail_payload_budget[0];
  await restored.prepare("INSERT INTO chain_detail_payload_budget(id,max_encoded_bytes,used_encoded_bytes,gc_after_sha256) VALUES(1,?,0,?)").bind(budget.max_encoded_bytes,budget.gc_after_sha256).run();
  for (const name of owners.filter((n)=>n!=="chain_detail_payload_budget")) {
    const statements=copy[name].map((row)=>{const columns=Object.keys(row);return restored.prepare(`INSERT INTO ${name}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).bind(...Object.values(row));});
    if (statements.length) await restored.batch(statements);
  }
  const after = await restored.batch(owners.map((name) => restored.prepare(`SELECT * FROM ${name} ORDER BY 1,2`)));
  assert.deepEqual(Object.fromEntries(owners.map((name,i)=>[name,after[i].results])),cut);
  assert.deepEqual(await Promise.all([loadExtrinsicHotTier(env(restored),"9000001-0"),loadBlockChainEventsHotTier(env(restored),9000002)]),original);
  await state(restored); await pruneChainDetailPayloads(env(restored));
  assert.deepEqual(await loadExtrinsicHotTier(env(restored),"9000001-0"),original[0]);
  await restored.prepare("DELETE FROM chain_detail_payload_chunks WHERE sha256=(SELECT MIN(sha256) FROM chain_detail_payload_chunks)").run();
  assert.notDeepEqual(await state(restored),await state());
});
