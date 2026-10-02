import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const migration = (name: string) =>
  readFileSync(new URL(`../migrations/d1/${name}`, import.meta.url), "utf8")
    .split("-- statement-breakpoint")
    .filter((sql) => sql.trim());
const apply = async (name: string) => {
  for (const sql of migration(name)) await db.prepare(sql).run();
};
beforeAll(async () => {
  vi.useRealTimers();
  db = await runtime.getD1Database("DB");
  await apply("0028_raw_capture_storage.sql");
  await apply("0029_raw_capture_archive.sql");
  await apply("0038_raw_capture_publications.sql");
});
afterAll(() => runtime.dispose());
beforeEach(async () => {
  vi.useRealTimers();
  await db.prepare("DROP TRIGGER IF EXISTS reject_publication").run();
  for (const table of [
    "raw_capture_archives",
    "raw_capture_selected",
    "raw_capture_chunks",
    "raw_capture_batches",
    "raw_capture_publications",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});
const key = (testnet = false) =>
  `chain/raw/${testnet ? "testnet/" : ""}blocks/000000000010-000000000010.ndjson`;
const value = (at: number, extrinsics = ["0x1234"]) =>
  JSON.stringify({
    block_number: 10,
    block_hash: "0x123",
    parent_hash: "0x122",
    header: { digest: { logs: ["0x00"] }, label: "链🧬", untouched: null },
    extrinsics,
    events: null,
    captured_at: at,
  }) + "\n";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const count = (table: string) =>
  db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n");
const selected = (objectKey: string) =>
  db
    .prepare("SELECT sha256 FROM raw_capture_selected WHERE key=?")
    .bind(objectKey)
    .first<string>("sha256");
const intercepted = (afterCommit: () => Promise<unknown>) => {
  let once = true;
  return rawCaptureD1({
    prepare: (sql: string) => db.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      const result = await db.batch(statements);
      if (once) {
        once = false;
        await afterCommit();
      }
      return result;
    },
  });
};
async function archive(objectKey: string, digest: string) {
  const descriptor = await db
    .prepare("SELECT * FROM raw_capture_batches WHERE key=? AND sha256=?")
    .bind(objectKey, digest)
    .first<{ network: string; compressed_sha256: string }>();
  assert(descriptor);
  await db
    .prepare(
      "INSERT INTO raw_capture_archives SELECT b.*,EXISTS(SELECT 1 FROM raw_capture_selected s WHERE s.key=b.key AND s.sha256=b.sha256),?,?,compressed_sha256 FROM raw_capture_batches b WHERE b.key=? AND b.sha256=?",
    )
    .bind(
      `chain/raw/native/v1/${descriptor.network}/${digest}/${descriptor.compressed_sha256}.gz`,
      "a".repeat(32),
      objectKey,
      digest,
    )
    .run();
}

test.each([false, true])(
  "D1 commits acknowledge both overlapping exact versions: testnet=%s",
  async (testnet) => {
    const objectKey = key(testnet),
      older = value(1000),
      newer = value(1049);
    const writer = intercepted(async () =>
      rawCaptureD1(db).put(objectKey, newer),
    );
    await writer.put(objectKey, older);
    assert.equal(await selected(objectKey), sha(newer));
    assert.equal(await count("raw_capture_publications"), 2);
    assert.equal(await count("raw_capture_batches"), 2);
    for (const raw of [older, newer]) {
      const chunks = await db
        .prepare(
          "SELECT hex(data) AS data FROM raw_capture_chunks WHERE key=? AND sha256=? ORDER BY part",
        )
        .bind(objectKey, sha(raw))
        .all<{ data: string }>();
      assert.equal(
        gunzipSync(
          Buffer.concat(
            chunks.results.map((row) => Buffer.from(row.data, "hex")),
          ),
        ).toString(),
        raw,
      );
    }
  },
);

test("D1 lost committed reply keeps the original publication through supersession and native archival", async () => {
  const objectKey = key(),
    older = value(1000),
    newer = value(1089);
  const writer = intercepted(async () => {
    await rawCaptureD1(db).put(objectKey, newer);
    await archive(objectKey, sha(older));
    await archive(objectKey, sha(newer));
    throw new Error("D1_ERROR: Network connection lost.");
  });
  await writer.put(objectKey, older);
  await rawCaptureD1(db).put(objectKey, older);
  assert.equal(await count("raw_capture_publications"), 2);
  assert.equal(await count("raw_capture_archives"), 2);
  assert.equal(await count("raw_capture_batches"), 0);
  assert.equal(
    await db
      .prepare("SELECT sha256 FROM raw_capture_archives WHERE selected=1")
      .first<string>("sha256"),
    sha(newer),
  );
  assert.equal(
    await db
      .prepare("SELECT objects FROM raw_capture_budget")
      .first<number>("objects"),
    0,
  );
});

test("D1 receipt failure atomically rolls back selection and completion", async () => {
  const store = rawCaptureD1(db),
    objectKey = key();
  await store.put(objectKey, value(1000));
  await db
    .prepare(
      "CREATE TRIGGER reject_publication BEFORE INSERT ON raw_capture_publications BEGIN SELECT RAISE(ABORT,'publication failed'); END",
    )
    .run();
  await assert.rejects(store.put(objectKey, value(2000)), /publication failed/);
  assert.equal(await selected(objectKey), sha(value(1000)));
  assert.equal(
    await db
      .prepare(
        "SELECT complete FROM raw_capture_batches WHERE captured_at=2000",
      )
      .first<number>("complete"),
    0,
  );
  assert.equal(await count("raw_capture_publications"), 1);
  await db.prepare("DROP TRIGGER reject_publication").run();
  await store.put(objectKey, value(2000));
  assert.equal(await selected(objectKey), sha(value(2000)));
  assert.equal(
    await db
      .prepare("SELECT objects FROM raw_capture_budget")
      .first<number>("objects"),
    2,
  );
});

test("D1 never acknowledges a conflicting version that did not win selection", async () => {
  const store = rawCaptureD1(db),
    objectKey = key();
  await store.put(objectKey, value(2000));
  await assert.rejects(
    store.put(objectKey, value(2000, ["0xffff"])),
    /selection was not acknowledged/,
  );
  assert.equal(await selected(objectKey), sha(value(2000)));
  assert.equal(await count("raw_capture_publications"), 1);
  assert.equal(await count("raw_capture_batches"), 2);
});

test.each([false, true])(
  "D1 acknowledges the reverse overlapping order only with exact chain-byte equivalence: testnet=%s",
  async (testnet) => {
    const store = rawCaptureD1(db),
      objectKey = key(testnet);
    const newer = value(2000),
      older = value(1000);
    await store.put(objectKey, newer);
    await store.put(objectKey, older);
    assert.equal(await selected(objectKey), sha(newer));
    const receipt = await db
      .prepare(
        "SELECT selected_sha256,chain_sha256 FROM raw_capture_publications WHERE key=? AND sha256=?",
      )
      .bind(objectKey, sha(older))
      .first<{ selected_sha256: string; chain_sha256: string }>();
    assert.equal(receipt?.selected_sha256, sha(newer));
    assert.equal(
      receipt?.chain_sha256,
      createHash("sha256")
        .update(older.replace('"captured_at":1000', '"captured_at":0'))
        .digest("hex"),
    );
    await assert.rejects(
      store.put(objectKey, value(900, ["0xffff"])),
      /selection was not acknowledged/,
    );
    assert.equal(await count("raw_capture_publications"), 2);
  },
);

test("D1 verifies an already archived newer selection before acknowledging an equivalent older original", async () => {
  const store = rawCaptureD1(db),
    objectKey = key();
  await store.put(objectKey, value(2000));
  await archive(objectKey, sha(value(2000)));
  await store.put(objectKey, value(1000));
  assert.equal(
    await db
      .prepare("SELECT sha256 FROM raw_capture_archives WHERE selected=1")
      .first<string>("sha256"),
    sha(value(2000)),
  );
  assert.equal(
    await db
      .prepare(
        "SELECT selected_sha256 FROM raw_capture_publications WHERE sha256=?",
      )
      .bind(sha(value(1000)))
      .first<string>("selected_sha256"),
    sha(value(2000)),
  );
  assert.equal(await count("raw_capture_publications"), 2);
  assert.equal(await count("raw_capture_batches"), 1);
});

test("D1 migration preserves existing descriptors and attests only current complete selections", async () => {
  const store = rawCaptureD1(db),
    objectKey = key();
  await store.put(objectKey, value(1000));
  await archive(objectKey, sha(value(1000)));
  await store.put(objectKey, value(2000));
  await archive(objectKey, sha(value(2000)));
  await store.put(key(true), value(1000));
  await db
    .prepare(
      "UPDATE raw_capture_batches SET complete=0 WHERE network='testnet'",
    )
    .run();
  const before = await db
    .prepare("SELECT * FROM raw_capture_archives ORDER BY captured_at")
    .all();
  await db.prepare("DROP TABLE raw_capture_publications").run();
  await apply("0038_raw_capture_publications.sql");
  assert.equal(await count("raw_capture_publications"), 1);
  assert.deepEqual(
    (
      await db
        .prepare("SELECT * FROM raw_capture_archives ORDER BY captured_at")
        .all()
    ).results,
    before.results,
  );
  await store.put(objectKey, value(2000));
  await assert.rejects(
    store.put(objectKey, value(1000)),
    /selection was not acknowledged/,
  );
});
