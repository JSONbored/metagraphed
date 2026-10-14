import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";
import type { D1StoreBinding } from "../src/d1-store.ts";
import { RAW_CAPTURE_GENESIS } from "../src/raw-capture-provenance.ts";
import { rawBatchKey, type RawBlockCapture } from "../src/raw-chain-capture.ts";
import {
  nativeRawFixture,
  syntheticNode,
} from "./helpers/raw-capture-fixture.ts";
const opened: Awaited<ReturnType<typeof nativeRawFixture>>[] = [];
afterEach(async () => {
  for (const f of opened.splice(0)) await f.runtime.dispose();
  vi.useRealTimers();
});
async function fixture(
  beforeFinality?: Parameters<typeof nativeRawFixture>[0],
) {
  vi.useRealTimers();
  const f = await nativeRawFixture(beforeFinality);
  opened.push(f);
  return f;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function setup(first = 10, head = 14) {
  const f = await fixture(),
    node = syntheticNode({ first, head });
  const checkpoint = await f.store.canonical!.bootstrap({
    network: "mainnet",
    previousHeight: null,
    height: first - 1,
    hash: node.hash(first - 1),
    genesis: RAW_CAPTURE_GENESIS.mainnet,
    finalized: { height: head, hash: node.hash(head) },
    now: 1000,
  });
  const rows: RawBlockCapture[] = Array.from(
    { length: head - first + 1 },
    (_, i) => {
      const n = first + i;
      const header = node.headers.get(n)!;
      return {
        block_number: n,
        block_hash: node.hash(n),
        parent_hash: String(header.parentHash),
        header,
        extrinsics: ["0x0401"],
        events: "0x00",
        captured_at: 1000,
      };
    },
  );
  return { f, node, checkpoint, rows };
}
const payload = (rows: RawBlockCapture[], at = 1000) =>
  rows.map((r) => JSON.stringify({ ...r, captured_at: at })).join("\n") + "\n";
async function archive(db: D1Database, key: string, digest: string) {
  const b = await db
    .prepare(
      "SELECT network,compressed_sha256 FROM raw_capture_batches WHERE key=? AND sha256=?",
    )
    .bind(key, digest)
    .first<{ network: string; compressed_sha256: string }>();
  assert(b);
  await db
    .prepare(
      "INSERT INTO raw_capture_archives SELECT b.*,EXISTS(SELECT 1 FROM raw_capture_selected s WHERE s.key=b.key AND s.sha256=b.sha256),?,?,compressed_sha256 FROM raw_capture_batches b WHERE b.key=? AND b.sha256=?",
    )
    .bind(
      `chain/raw/native/v1/${b.network}/${digest}/${b.compressed_sha256}.gz`,
      "a".repeat(32),
      key,
      digest,
    )
    .run();
}

test("migration preserves legacy height/errors and refuses partial/unsafe anchors", async () => {
  const f = await fixture(async (db) => {
    await db
      .prepare(
        "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at,stopped_at,last_error) VALUES('mainnet',9,7,10,'historical failure')",
      )
      .run();
  });
  const legacy = await f.store.canonical!.read("mainnet");
  assert.equal(legacy?.genesis, null);
  assert.equal(legacy?.height, 9);
  assert.deepEqual(
    await f.db
      .prepare("SELECT updated_at,stopped_at,last_error FROM raw_capture_state")
      .first(),
    { updated_at: 7, stopped_at: 10, last_error: "historical failure" },
  );
  await assert.rejects(
    f.db
      .prepare(
        "UPDATE raw_capture_state SET genesis_hash=? WHERE network='mainnet'",
      )
      .bind(RAW_CAPTURE_GENESIS.mainnet)
      .run(),
    /proof required/,
  );
  await assert.rejects(
    f.db
      .prepare(
        "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('testnet',9007199254740992,1)",
      )
      .run(),
    /Invalid raw capture checkpoint/,
  );
});

test("bootstrap does not certify old bytes and a lost legacy CAS cannot silently initialize", async () => {
  const f = await fixture(),
    node = syntheticNode();
  const input = {
    network: "mainnet" as const,
    previousHeight: 9,
    height: 9,
    hash: node.hash(9),
    genesis: RAW_CAPTURE_GENESIS.mainnet,
    finalized: { height: 14, hash: node.hash(14) },
    now: 1000,
  };
  await f.db
    .prepare(
      "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('mainnet',10,7)",
    )
    .run();
  await assert.rejects(
    f.store.canonical!.bootstrap(input),
    /bootstrap was not committed/,
  );
  assert.equal((await f.store.canonical!.read("mainnet"))?.genesis, null);
  const cp = await f.store.canonical!.bootstrap({
    ...input,
    previousHeight: 10,
    height: 10,
    hash: node.hash(10),
  });
  assert.equal(cp.verifiedFrom, 11);
  assert.equal(cp.revision, 0);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) n FROM raw_capture_finality")
      .first<number>("n"),
    0,
  );
  assert.equal(
    (
      await f.store.canonical!.bootstrap({
        ...input,
        previousHeight: 10,
        height: 10,
        hash: node.hash(10),
      })
    ).height,
    10,
  );
});

test("canonical publication, proof and exact frontier CAS commit together", async () => {
  const { f, checkpoint, rows } = await setup();
  const key = rawBatchKey(10, 14),
    value = payload(rows);
  const proof = {
    checkpoint,
    finalized: { height: 14, hash: rows.at(-1)!.block_hash },
  };
  const cp = await f.store.canonical!.commit(key, value, proof);
  assert.equal(cp.height, 14);
  assert.equal(cp.hash, rows.at(-1)!.block_hash);
  assert.equal(cp.revision, 1);
  assert.equal(cp.verifiedFrom, 10);
  assert.equal(
    await f.db
      .prepare("SELECT sha256 FROM raw_capture_publications WHERE key=?")
      .bind(key)
      .first<string>("sha256"),
    sha(value),
  );
  assert.equal(
    await f.db
      .prepare(
        "SELECT frontier_hash FROM raw_capture_finality WHERE network='mainnet' AND revision=1",
      )
      .first<string>("frontier_hash"),
    cp.hash,
  );
  await assert.rejects(
    f.db
      .prepare(
        "UPDATE raw_capture_state SET last_contiguous_block=15 WHERE network='mainnet'",
      )
      .run(),
    /proof required/,
  );
  await assert.rejects(
    f.db
      .prepare(
        "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('mainnet',15,1000) ON CONFLICT(network) DO UPDATE SET last_contiguous_block=excluded.last_contiguous_block",
      )
      .run(),
    /Invalid raw capture checkpoint/,
  );
  await assert.rejects(
    f.db.prepare("DELETE FROM raw_capture_state WHERE network='mainnet'").run(),
    /retained/,
  );
  await assert.rejects(
    f.db
      .prepare("UPDATE raw_capture_finality SET frontier_hash=?")
      .bind(checkpoint.hash)
      .run(),
    /immutable/,
  );
  await assert.rejects(
    f.db
      .prepare("UPDATE raw_capture_publications SET chain_sha256=?")
      .bind("f".repeat(64))
      .run(),
    /immutable/,
  );
  await assert.rejects(
    f.db.prepare("DELETE FROM raw_capture_publications").run(),
    /retained/,
  );
  await assert.rejects(
    f.db.prepare("DELETE FROM raw_capture_finality").run(),
    /retained/,
  );
});

test("a refused zero-row frontier update rolls back publication/proof, then recovers", async () => {
  const { f, checkpoint, rows } = await setup();
  const key = rawBatchKey(10, 14),
    value = payload(rows),
    proof = {
      checkpoint,
      finalized: { height: 14, hash: rows.at(-1)!.block_hash },
    };
  await f.db
    .prepare(
      "CREATE TRIGGER refuse_frontier BEFORE UPDATE ON raw_capture_state WHEN NEW.last_contiguous_block>OLD.last_contiguous_block BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  await assert.rejects(
    f.store.canonical!.commit(key, value, proof),
    /frontier CAS refused/,
  );
  assert.equal((await f.store.canonical!.read("mainnet"))?.height, 9);
  for (const table of [
    "raw_capture_selected",
    "raw_capture_publications",
    "raw_capture_finality",
  ])
    assert.equal(
      await f.db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n"),
      0,
    );
  await f.db.prepare("DROP TRIGGER refuse_frontier").run();
  assert.equal((await f.store.canonical!.commit(key, value, proof)).height, 14);
});

test.each([false, true])(
  "two exact-chain captures in either order share one canonical transition (%s)",
  async (reverse) => {
    const { f, checkpoint, rows } = await setup();
    const key = rawBatchKey(10, 14),
      older = payload(rows, 1000),
      newer = payload(rows, 1100),
      proof = {
        checkpoint,
        finalized: { height: 14, hash: rows.at(-1)!.block_hash },
      };
    for (const value of reverse ? [newer, older] : [older, newer])
      assert.equal(
        (await f.store.canonical!.commit(key, value, proof)).height,
        14,
      );
    assert.equal((await f.store.canonical!.read("mainnet"))?.revision, 1);
    assert.equal(
      await f.db
        .prepare("SELECT count(*) n FROM raw_capture_finality")
        .first<number>("n"),
      1,
    );
    assert.equal(
      await f.db
        .prepare("SELECT count(*) n FROM raw_capture_publications")
        .first<number>("n"),
      2,
    );
  },
);

test("a stale different range cannot publish or move the winning frontier", async () => {
  const { f, checkpoint, rows } = await setup();
  const finalized = { height: 14, hash: rows.at(-1)!.block_hash };
  await f.store.canonical!.commit(
    rawBatchKey(10, 12),
    payload(rows.slice(0, 3)),
    { checkpoint, finalized },
  );
  await assert.rejects(
    f.store.canonical!.commit(rawBatchKey(10, 14), payload(rows), {
      checkpoint,
      finalized,
    }),
    /not acknowledged|not committed/,
  );
  assert.equal((await f.store.canonical!.read("mainnet"))?.height, 12);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) n FROM raw_capture_finality")
      .first<number>("n"),
    1,
  );
});

test("lost committed reply resolves its receipt after native archival", async () => {
  const { f, checkpoint, rows } = await setup();
  const key = rawBatchKey(10, 14),
    value = payload(rows),
    proof = {
      checkpoint,
      finalized: { height: 14, hash: rows.at(-1)!.block_hash },
    };
  let lost = false;
  const binding: D1StoreBinding = {
    prepare: (q) => f.db.prepare(q),
    async batch<T>(statements: D1PreparedStatement[]) {
      const result = await f.db.batch<T>(statements);
      if (
        !lost &&
        (await f.db
          .prepare("SELECT count(*) n FROM raw_capture_finality")
          .first<number>("n"))
      ) {
        lost = true;
        await archive(f.db, key, sha(value));
        throw new Error("Network connection lost.");
      }
      return result;
    },
  };
  const cp = await rawCaptureD1(binding).canonical!.commit(key, value, proof);
  assert.equal(cp.height, 14);
  assert.equal(lost, true);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) n FROM raw_capture_batches")
      .first<number>("n"),
    0,
  );
  assert.equal(
    (await f.store.canonical!.commit(key, value, proof)).revision,
    1,
  );
});

test("an exact old receipt remains acknowledged after a newer canonical descendant", async () => {
  const { f, checkpoint, rows } = await setup();
  const finalized = { height: 14, hash: rows.at(-1)!.block_hash },
    first = payload(rows.slice(0, 3));
  const cp = await f.store.canonical!.commit(rawBatchKey(10, 12), first, {
    checkpoint,
    finalized,
  });
  await f.store.canonical!.commit(rawBatchKey(13, 14), payload(rows.slice(3)), {
    checkpoint: cp,
    finalized,
  });
  assert.equal(
    (
      await f.store.canonical!.commit(rawBatchKey(10, 12), first, {
        checkpoint,
        finalized,
      })
    ).height,
    14,
  );
});

test("the authentic fixed-hash block is captured against the original predecessor", async () => {
  const f = await fixture();
  const vector = JSON.parse(
    readFileSync(
      new URL("./fixtures/raw-capture/mainnet-9277292.json", import.meta.url),
      "utf8",
    ),
  );
  const row = { ...vector.block, captured_at: 1000 };
  const cp = await f.store.canonical!.bootstrap({
    network: "mainnet",
    previousHeight: null,
    height: row.block_number - 1,
    hash: row.parent_hash,
    genesis: RAW_CAPTURE_GENESIS.mainnet,
    finalized: { height: row.block_number, hash: row.block_hash },
    now: 1000,
  });
  const result = await f.store.canonical!.commit(
    rawBatchKey(row.block_number, row.block_number),
    JSON.stringify(row) + "\n",
    {
      checkpoint: cp,
      finalized: { height: row.block_number, hash: row.block_hash },
    },
  );
  assert.equal(result.hash, vector.provenance.block_hash);
  assert.equal(result.verifiedFrom, row.block_number);
});

test("legacy future timestamps cannot suppress canonical selection or later supersede it", async () => {
  const f = await fixture(),
    node = syntheticNode();
  const rows = [10, 11, 12, 13, 14].map((n) => ({
    block_number: n,
    block_hash: node.hash(n),
    parent_hash: String(node.headers.get(n)!.parentHash),
    header: node.headers.get(n),
    extrinsics: ["0x0401"],
    events: "0x00",
    captured_at: 5000,
  }));
  const key = rawBatchKey(10, 14),
    legacy = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await f.store.put(key, legacy);
  const cp = await f.store.canonical!.bootstrap({
    network: "mainnet",
    previousHeight: null,
    height: 9,
    hash: node.hash(9),
    genesis: RAW_CAPTURE_GENESIS.mainnet,
    finalized: { height: 14, hash: node.hash(14) },
    now: 1000,
  });
  const current =
    rows.map((r) => JSON.stringify({ ...r, captured_at: 1000 })).join("\n") +
    "\n";
  await f.store.canonical!.commit(key, current, {
    checkpoint: cp,
    finalized: { height: 14, hash: node.hash(14) },
  });
  const later =
    rows.map((r) => JSON.stringify({ ...r, captured_at: 6000 })).join("\n") +
    "\n";
  await f.store.put(key, later);
  assert.equal(
    await f.db
      .prepare("SELECT sha256 FROM raw_capture_selected WHERE key=?")
      .bind(key)
      .first<string>("sha256"),
    sha(current),
  );
});

test("overlapping native writers qualify the same bytes once; a different range loses its CAS", async () => {
  const { f, checkpoint, rows } = await setup();
  const proof = {
    checkpoint,
    finalized: { height: 14, hash: rows.at(-1)!.block_hash },
  };
  const key = rawBatchKey(10, 14);
  const equal = await Promise.all([
    f.store.canonical!.commit(key, payload(rows, 1000), proof),
    rawCaptureD1(f.db).canonical!.commit(key, payload(rows, 1100), proof),
  ]);
  assert.ok(equal.every((cp) => cp.height === 14 && cp.revision === 1));
  await assert.rejects(
    f.store.canonical!.commit(
      rawBatchKey(10, 12),
      payload(rows.slice(0, 3)),
      proof,
    ),
    /not acknowledged|not committed/,
  );
  assert.equal((await f.store.canonical!.read("mainnet"))?.revision, 1);
});

test("canonical identity, range and closing finalized hash reject before any publication", async () => {
  const { f, checkpoint, rows } = await setup();
  const finalized = { height: 14, hash: rows.at(-1)!.block_hash };
  for (const proof of [
    { checkpoint: { ...checkpoint, network: "testnet" as const }, finalized },
    { checkpoint: { ...checkpoint, height: 8 }, finalized },
    { checkpoint, finalized: { ...finalized, height: 13 } },
    { checkpoint, finalized: { ...finalized, height: 14.5 } },
    { checkpoint, finalized: { ...finalized, height: 4294967296 } },
    { checkpoint: { ...checkpoint, finalizedHeight: 15 }, finalized },
    {
      checkpoint: { ...checkpoint, finalizedHash: `0x${"ff".repeat(32)}` },
      finalized,
    },
    {
      checkpoint: { ...checkpoint, revision: Number.MAX_SAFE_INTEGER },
      finalized,
    },
  ])
    await assert.rejects(
      f.store.canonical!.commit(rawBatchKey(10, 14), payload(rows), proof),
      /canonical range differs/,
    );
  await assert.rejects(
    f.store.canonical!.commit(rawBatchKey(10, 14), payload(rows), {
      checkpoint: { ...checkpoint, finalizedHeight: 13 },
      finalized: { height: 14, hash: `0x${"ff".repeat(32)}` },
    }),
    /finalized frontier differs/,
  );
  assert.equal(
    await f.db
      .prepare("SELECT count(*) n FROM raw_capture_publications")
      .first<number>("n"),
    0,
  );
});

test("bootstrap input failures and direct mutations cannot create or relabel coverage", async () => {
  const { f, node, checkpoint } = await setup();
  const input = {
    network: "testnet" as const,
    previousHeight: null,
    height: 9,
    hash: node.hash(9),
    genesis: RAW_CAPTURE_GENESIS.testnet,
    finalized: { height: 14, hash: node.hash(14) },
    now: 1000,
  };
  for (const over of [
    { height: -2 },
    { height: 1.5 },
    { height: 4294967296 },
    { finalized: { height: 8, hash: node.hash(14) } },
    { finalized: { height: 14.5, hash: node.hash(14) } },
    { finalized: { height: 4294967296, hash: node.hash(14) } },
    { now: 0 },
    { now: Infinity },
    { previousHeight: 8 },
  ])
    await assert.rejects(
      f.store.canonical!.bootstrap({ ...input, ...over }),
      /Invalid raw capture bootstrap/,
    );
  for (const sql of [
    "UPDATE raw_capture_state SET network='testnet' WHERE network='mainnet'",
    "UPDATE raw_capture_state SET last_contiguous_block=8 WHERE network='mainnet'",
    "UPDATE raw_capture_state SET finalized_height=13 WHERE network='mainnet'",
    "UPDATE raw_capture_state SET frontier_hash=NULL WHERE network='mainnet'",
    "UPDATE raw_capture_state SET checkpoint_revision=1 WHERE network='mainnet'",
    "INSERT OR REPLACE INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('mainnet',9,2)",
  ])
    await assert.rejects(f.db.prepare(sql).run(), /checkpoint/);
  assert.deepEqual(await f.store.canonical!.read("mainnet"), checkpoint);
});

test("a pre-migration invalid legacy height is refused rather than interpreted as a genesis restart", async () => {
  const f = await fixture(async (db) => {
    await db
      .prepare(
        "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('mainnet',9007199254740992,1)",
      )
      .run();
  });
  await assert.rejects(
    f.store.canonical!.read("mainnet"),
    /Invalid raw capture checkpoint/,
  );
});
