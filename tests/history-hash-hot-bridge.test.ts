import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { historyHashAbsentFromHotBridge as absent } from "../src/history-hash-hot-bridge.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
  r2Buckets: ["R2"],
});
let db: D1Database;
let bucket: R2Bucket;
const hash = `0x${"ab".repeat(32)}`;
const key = (table = "blocks") =>
  `metagraph/indexed-history/v1/mainnet/${table}/source-ceiling.json`;
const ceiling = (table = "blocks", through = 12) => ({
  version: 1,
  network: "mainnet",
  table,
  through,
  revision: "a".repeat(32),
});
const env = () => ({
  D1_STATE: db,
  D1_STATE_TABLES: "chain_detail_blocks,chain_detail_extrinsics",
  METAGRAPH_ARCHIVE: bucket,
});
const check = (table: "blocks" | "extrinsics" = "blocks") =>
  absent(env(), table, hash, 10, "mainnet");
async function block(height: number, blockHash = "other") {
  await db
    .prepare(
      "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,?,0,0,0,1,1)",
    )
    .bind(height, blockHash)
    .run();
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  bucket = (await runtime.getR2Bucket("R2")) as unknown as R2Bucket;
  for (const sql of readFileSync(
    new URL("../migrations/d1/0014_recent_chain_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
  await db
    .prepare(
      readFileSync(
        new URL(
          "../migrations/d1/0021_chain_detail_hash_index.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  await db.prepare("DELETE FROM chain_detail_extrinsics").run();
  await db.prepare("DELETE FROM chain_detail_blocks").run();
  for (const n of [11, 12, 13]) await block(n);
  for (const table of ["blocks", "extrinsics"])
    await bucket.put(key(table), JSON.stringify(ceiling(table)));
});

test("complete D1 coverage proves absence for both indexed hash families", async () => {
  assert.equal(await check(), true);
  assert.equal(await check("extrinsics"), true);
  // The bound is an upper bound, not a demand that hot and decoded heads match.
  await bucket.put(key(), JSON.stringify(ceiling("blocks", 10)));
  assert.equal(await check(), true);
});

test("a hash anywhere in hot history prevents an empty result", async () => {
  await block(9, hash.toUpperCase());
  assert.equal(await check(), false);
  await db
    .prepare(
      "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,extrinsic_hash,observed_at) VALUES(9,0,?,1)",
    )
    .bind(hash.toUpperCase())
    .run();
  assert.equal(
    await absent(env(), "extrinsics", hash.toUpperCase(), 10, "mainnet"),
    false,
  );
  const plans = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM chain_detail_extrinsics WHERE lower(extrinsic_hash)=? LIMIT 1",
    )
    .bind(hash)
    .all();
  assert.match(
    JSON.stringify(plans.results),
    /idx_chain_detail_extrinsics_hash_lower/,
  );
  const blocksPlan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM chain_detail_blocks WHERE lower(block_hash)=? LIMIT 1",
    )
    .bind(hash)
    .all();
  assert.match(
    JSON.stringify(blocksPlan.results),
    /SEARCH .*idx_chain_detail_blocks_hash_lower/,
  );
  assert.doesNotMatch(JSON.stringify(blocksPlan.results), /SCAN|TEMP/);
});

test("an entirely indexed source needs no additional hot tail", async () => {
  await bucket.put(key(), JSON.stringify(ceiling("blocks", 10)));
  await db.prepare("DELETE FROM chain_detail_blocks").run();
  assert.equal(await check(), true);
  await block(9);
  assert.equal(await check(), true);
  await block(10, hash.toUpperCase());
  assert.equal(await check(), false);
});

test("missing, pruned, gapped or excessively long hot coverage keeps fallback", async () => {
  await db
    .prepare("DELETE FROM chain_detail_blocks WHERE block_number=12")
    .run();
  assert.equal(await check(), false);
  await block(12);
  await db
    .prepare("DELETE FROM chain_detail_blocks WHERE block_number=11")
    .run();
  assert.equal(await check(), false);
  await block(11);
  await block(40000);
  assert.equal(await check(), false);
  await db.prepare("DELETE FROM chain_detail_blocks").run();
  assert.equal(await check(), false);
});

test("hot coverage must reach pending rows even before their append finishes", async () => {
  await bucket.put(key(), JSON.stringify(ceiling("blocks", 14)));
  assert.equal(await check(), false);
  await block(14);
  assert.equal(await check(), true);
});

test("missing qualification and unsupported networks retain the fallback", async () => {
  assert.equal(await absent(env(), "blocks", hash, 10, "testnet"), false);
  assert.equal(await absent(null, "blocks", hash, 10, "mainnet"), false);
  assert.equal(
    await absent(
      { ...env(), D1_STATE_TABLES: "" },
      "blocks",
      hash,
      10,
      "mainnet",
    ),
    false,
  );
  assert.equal(
    await absent(
      { ...env(), METAGRAPH_ARCHIVE: undefined },
      "blocks",
      hash,
      10,
      "mainnet",
    ),
    false,
  );
  await bucket.delete(key());
  assert.equal(await check(), false);
});

test("a changed or removed fence cannot qualify the earlier D1 snapshot", async () => {
  for (const remove of [false, true]) {
    await bucket.put(key(), JSON.stringify(ceiling()));
    let reads = 0;
    const get = async (k: string) => {
      if (++reads === 2) {
        if (remove) await bucket.delete(k);
        else
          await bucket.put(
            k,
            JSON.stringify({ ...ceiling(), revision: "b".repeat(32) }),
          );
      }
      return bucket.get(k);
    };
    assert.equal(
      await absent(
        { ...env(), METAGRAPH_ARCHIVE: { get } },
        "blocks",
        hash,
        10,
        "mainnet",
      ),
      false,
    );
  }
});

test("corrupt or foreign ceilings and broken selected stores are errors", async () => {
  for (const value of [
    { ...ceiling(), network: "testnet" },
    { ...ceiling(), table: "extrinsics" },
    { ...ceiling(), through: -1 },
    { ...ceiling(), revision: "invalid" },
  ]) {
    await bucket.put(key(), JSON.stringify(value));
    await assert.rejects(check());
  }
  await bucket.put(key(), " ".repeat(8193));
  await assert.rejects(check(), /budget/);
  const get = vi
    .fn()
    .mockResolvedValue({ size: 1, json: async () => ceiling(), etag: "" });
  await assert.rejects(
    absent(
      { ...env(), METAGRAPH_ARCHIVE: { get } },
      "blocks",
      hash,
      10,
      "mainnet",
    ),
    /scope/,
  );
  await assert.rejects(
    absent({ ...env(), D1_STATE: undefined }, "blocks", hash, 10, "mainnet"),
  );
  await assert.rejects(
    absent(
      { ...env(), D1_STATE_TABLES: "chain_detail_blocks" },
      "extrinsics",
      hash,
      10,
      "mainnet",
    ),
  );
  await bucket.put(key(), JSON.stringify(ceiling()));
  const fakeDb = {
    batch: vi.fn(),
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  };
  assert.equal(
    await absent({ ...env(), D1_STATE: fakeDb }, "blocks", hash, 10, "mainnet"),
    false,
  );
  await db
    .prepare("ALTER TABLE chain_detail_blocks RENAME TO held_blocks")
    .run();
  try {
    await assert.rejects(check());
  } finally {
    await db
      .prepare("ALTER TABLE held_blocks RENAME TO chain_detail_blocks")
      .run();
  }
});
