import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import { RAW_CAPTURE_GENESIS } from "../src/raw-capture-provenance.ts";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";
import { captureTick, rawBatchKey } from "../src/raw-chain-capture.ts";
import {
  nativeRawFixture,
  syntheticNode,
} from "./helpers/raw-capture-fixture.ts";
import { priorPublication } from "./helpers/raw-capture-prior-runtime.ts";
const runtimes: Miniflare[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  vi.useRealTimers();
});
const sha = (b: string | Uint8Array) =>
  createHash("sha256").update(b).digest("hex");
const etag = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const key = rawBatchKey(10, 14);
const watermark = {
  read: async () => {
    throw new Error("legacy cursor must not run");
  },
  write: async () => {
    throw new Error("legacy cursor must not run");
  },
};
function rows(node: ReturnType<typeof syntheticNode>, at: number) {
  return [10, 11, 12, 13, 14].map((n) => ({
    block_number: n,
    block_hash: node.hash(n),
    parent_hash: String(node.headers.get(n)!.parentHash),
    header: node.headers.get(n),
    extrinsics: ["0x0401"],
    events: "0x00",
    captured_at: at,
  }));
}
const raw = (r: ReturnType<typeof rows>) =>
  r.map((x) => JSON.stringify(x)).join("\n") + "\n";
async function retainBytesAndArchive(
  db: D1Database,
  objectKey: string,
  digest: string,
  directory: string,
) {
  const b = await db
    .prepare("SELECT * FROM raw_capture_batches WHERE key=? AND sha256=?")
    .bind(objectKey, digest)
    .first<{
      network: string;
      compressed_sha256: string;
      compressed_bytes: number;
      raw_bytes: number;
    }>();
  assert(b);
  const chunks = await db
    .prepare(
      "SELECT hex(data) data FROM raw_capture_chunks WHERE key=? AND sha256=? ORDER BY part",
    )
    .bind(objectKey, digest)
    .all<{ data: string }>();
  const bytes = Buffer.concat(
    chunks.results.map((x) => Buffer.from(x.data, "hex")),
  );
  assert.equal(bytes.length, b.compressed_bytes);
  assert.equal(sha(bytes), b.compressed_sha256);
  const decoded = gunzipSync(bytes);
  assert.equal(decoded.length, b.raw_bytes);
  assert.equal(sha(decoded), digest);
  const nativeKey = `chain/raw/native/v1/${b.network}/${digest}/${b.compressed_sha256}.gz`;
  const file = join(directory, b.compressed_sha256 + ".gz");
  writeFileSync(file, bytes);
  // Read the physical content-addressed object independently before the native
  // handoff can release staging. This is a local fixture object, not CF assets.
  assert.deepEqual(readFileSync(file), bytes);
  await db
    .prepare(
      "INSERT INTO raw_capture_archives SELECT b.*,EXISTS(SELECT 1 FROM raw_capture_selected s WHERE s.key=b.key AND s.sha256=b.sha256),?,?,compressed_sha256 FROM raw_capture_batches b WHERE b.key=? AND b.sha256=?",
    )
    .bind(nativeKey, etag(bytes), objectKey, digest)
    .run();
  return {
    nativeKey,
    file,
    digest,
    compressed: b.compressed_sha256,
    etag: etag(bytes),
  };
}

type ArchiveReceipt = Awaited<ReturnType<typeof retainBytesAndArchive>>;

test("actual pre0038 migration, prospective capture and closed native persistence restore preserve receipt/next-block ownership", async () => {
  vi.useRealTimers();
  const root = mkdtempSync(join(tmpdir(), "metagraph-raw-native-restore-"));
  roots.push(root);
  const sourcePersist = join(root, "source-state"),
    sourceObjects = join(root, "source-objects");
  mkdirSync(sourceObjects);
  const node = syntheticNode(),
    legacy = raw(rows(node, 5000)),
    bytes = gzipSync(legacy);
  let legacyArchive: ArchiveReceipt | undefined;
  const f = await nativeRawFixture(
    async (db) => {
      // This NULL receipt was created by the real applied0038 DDL, not UPDATE.
      assert.equal(
        await db
          .prepare(
            "SELECT chain_sha256 FROM raw_capture_publications WHERE key=? AND sha256=?",
          )
          .bind(key, sha(legacy))
          .first<string>("chain_sha256"),
        null,
      );
      assert.equal(
        await db
          .prepare(
            "SELECT last_contiguous_block FROM raw_capture_state WHERE network='mainnet'",
          )
          .first<number>("last_contiguous_block"),
        9,
      );
    },
    {
      persistDirectory: sourcePersist,
      beforePublication: async (db) => {
        await db
          .prepare(
            "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at,stopped_at,last_error) VALUES('mainnet',9,7,10,'legacy failure')",
          )
          .run();
        await db
          .prepare(
            "INSERT INTO raw_capture_batches(key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at,complete) VALUES(?,?,'mainnet',10,14,?,?,?,1,5000,1)",
          )
          .bind(
            key,
            sha(legacy),
            Buffer.byteLength(legacy),
            bytes.length,
            sha(bytes),
          )
          .run();
        await db
          .prepare(
            "INSERT INTO raw_capture_chunks(key,sha256,part,data) VALUES(?,?,0,?)",
          )
          .bind(key, sha(legacy), Uint8Array.from(bytes).buffer)
          .run();
        await db
          .prepare(
            "INSERT INTO raw_capture_selected(key,sha256,network,last_block,captured_at) VALUES(?,?,'mainnet',14,5000)",
          )
          .bind(key, sha(legacy))
          .run();
        legacyArchive = await retainBytesAndArchive(
          db,
          key,
          sha(legacy),
          sourceObjects,
        );
      },
    },
  );
  runtimes.push(f.runtime);
  assert(legacyArchive);
  assert.equal((await f.store.canonical!.read("mainnet"))?.genesis, null);
  const capture = await captureTick({
    rpcUrls: ["https://fixture.example"],
    store: f.store,
    canonical: f.store.canonical,
    watermark,
    network: "mainnet",
    genesisFloor: 10,
    maxPerTick: 50,
    fetchImpl: node.fetchImpl,
    now: () => 1000,
    sleepFn: async () => {},
  });
  assert.equal(capture.watermark, 14);
  const cp = await f.store.canonical!.read("mainnet");
  assert(cp?.genesis);
  assert.equal(cp.verifiedFrom, 10);
  const value = raw(rows(node, 1000)),
    archive = await retainBytesAndArchive(f.db, key, sha(value), sourceObjects);
  const proof = {
    checkpoint: {
      network: "mainnet" as const,
      genesis: RAW_CAPTURE_GENESIS.mainnet,
      height: 9,
      hash: node.hash(9),
      verifiedFrom: 10,
      finalizedHeight: 14,
      finalizedHash: node.hash(14),
      revision: 0,
    },
    finalized: { height: 14, hash: node.hash(14) },
  };
  assert.equal((await f.store.canonical!.commit(key, value, proof)).height, 14);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) n FROM raw_capture_batches")
      .first<number>("n"),
    0,
  );

  // Snapshot the entire native SQLite persistence tree only after workerd closes.
  // This avoids partial row replay and retains its tables, triggers and proofs.
  await f.runtime.dispose();
  runtimes.splice(runtimes.indexOf(f.runtime), 1);
  const restoredPersist = join(root, "restored-state"),
    restoredObjects = join(root, "restored-objects");
  cpSync(sourcePersist, restoredPersist, { recursive: true });
  cpSync(sourceObjects, restoredObjects, { recursive: true });
  const restored = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
    resourcePersistencePath: restoredPersist,
  });
  runtimes.push(restored);
  const db = await restored.getD1Database("DB"),
    store = rawCaptureD1(db);
  for (const retained of [legacyArchive, archive]) {
    const actual = readFileSync(
      join(restoredObjects, retained.compressed + ".gz"),
    );
    assert.equal(sha(actual), retained.compressed);
    assert.equal(etag(actual), retained.etag);
    assert.equal(sha(gunzipSync(actual)), retained.digest);
  }
  assert.deepEqual(await store.canonical!.read("mainnet"), cp);
  assert.equal((await store.canonical!.commit(key, value, proof)).revision, 1);
  const bad = raw(rows(node, 6000).map((r) => ({ ...r, events: "0x01" })));
  await assert.rejects(store.put(key, bad), /not acknowledged/);
  await assert.rejects(
    priorPublication(db, key, sha(bad)),
    /selector proof required/,
  );
  const next = syntheticNode({ head: 16 });
  const resume = await captureTick({
    rpcUrls: ["https://fixture.example"],
    store,
    canonical: store.canonical,
    watermark,
    network: "mainnet",
    genesisFloor: 10,
    maxPerTick: 50,
    fetchImpl: next.fetchImpl,
    now: () => 7000,
    sleepFn: async () => {},
  });
  assert.equal(resume.captured, 2);
  assert.equal(resume.watermark, 16);
  assert.equal((await store.canonical!.read("mainnet"))?.verifiedFrom, 10);
  assert.ok(
    next.requests
      .filter((r) => r.method === "chain_getBlock")
      .every(
        (r) => r.params[0] === next.hash(15) || r.params[0] === next.hash(16),
      ),
  );
  // Corrupt physical restore bytes fail independent digest verification.
  const corrupt = readFileSync(
    join(restoredObjects, archive.compressed + ".gz"),
  );
  corrupt[0] = corrupt[0]! ^ 1;
  assert.notEqual(sha(corrupt), archive.compressed);
});
