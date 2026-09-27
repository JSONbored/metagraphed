import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, test } from "vitest";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";
import { runRawCaptureSync } from "../src/raw-capture-sync.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const key = (testnet = false) =>
  `chain/raw/${testnet ? "testnet/" : ""}blocks/000000000010-000000000010.ndjson`;
const value = (at = 1000, extrinsics = ["0x00"]) =>
  JSON.stringify({
    block_number: 10,
    block_hash: "0x123",
    parent_hash: "0x122",
    header: { digest: { logs: [] } },
    extrinsics,
    events: null,
    captured_at: at,
  }) + "\n";
function fixture() {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(
    readFileSync(
      new URL("../migrations/d1/0028_raw_capture_storage.sql", import.meta.url),
      "utf8",
    ),
  );
  let fail: ((text: string, params: unknown[]) => void) | undefined;
  const prepared = (text: string, params: unknown[] = []) => ({
    text,
    params,
    bind(...next: unknown[]) {
      return prepared(
        text,
        next.map((value) =>
          value instanceof ArrayBuffer ? Buffer.from(value) : value,
        ),
      );
    },
    async first() {
      fail?.(text, params);
      return sql.prepare(text).get(...(params as never[])) ?? null;
    },
    async run() {
      fail?.(text, params);
      sql.prepare(text).run(...(params as never[]));
      return { success: true };
    },
    async all() {
      fail?.(text, params);
      return {
        success: true,
        results: sql.prepare(text).all(...(params as never[])),
      };
    },
  });
  const db = {
    prepare: prepared,
    async batch(statements: ReturnType<typeof prepared>[]) {
      sql.exec("BEGIN");
      try {
        const result = statements.map(({ text, params }) => {
          fail?.(text, params);
          return {
            success: true,
            results: sql.prepare(text).all(...(params as never[])),
          };
        });
        sql.exec("COMMIT");
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as Pick<D1Database, "prepare" | "batch">;
  const selected = (objectKey = key()) =>
    sql
      .prepare("SELECT sha256 FROM raw_capture_selected WHERE key=?")
      .get(objectKey)?.sha256;
  return {
    sql,
    db,
    store: rawCaptureD1(db),
    selected,
    failWith(fn?: typeof fail) {
      fail = fn;
    },
  };
}

test("both networks reconstruct exact raw bytes and null events through the real schema", async () => {
  const f = fixture(),
    raw = value();
  for (const testnet of [false, true]) {
    await f.store.put(key(testnet), raw);
    const rows = f.sql
      .prepare(
        "SELECT c.data FROM raw_capture_selected s JOIN raw_capture_chunks c USING(key,sha256) WHERE s.key=? ORDER BY c.part",
      )
      .all(key(testnet)) as { data: Uint8Array }[];
    assert.equal(
      gunzipSync(
        Buffer.concat(rows.map((r) => Buffer.from(r.data))),
      ).toString(),
      raw,
    );
    assert.equal(
      f.selected(key(testnet)),
      createHash("sha256").update(raw).digest("hex"),
    );
  }
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    2,
  );
});

test("chunking stays bounded and retries reuse existing immutable storage", async () => {
  const f = fixture(),
    raw = value(1000, [randomBytes(180_000).toString("hex")]);
  await f.store.put(key(), raw);
  await f.store.put(key(), raw);
  const chunks = f.sql
    .prepare(
      "SELECT count(*) n, max(length(data)) bytes FROM raw_capture_chunks",
    )
    .get()!;
  assert(Number(chunks.n) > 1);
  assert(Number(chunks.bytes) <= 65_536);
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    1,
  );
});

test("a partial write or corrupt readback never replaces the prior selected capture", async () => {
  const f = fixture();
  await f.store.put(key(), value());
  const prior = f.selected();
  f.failWith((text) => {
    if (text.startsWith("INSERT INTO raw_capture_chunks"))
      throw new Error("lost connection");
  });
  await assert.rejects(f.store.put(key(), value(2000)));
  assert.equal(f.selected(), prior);
  f.failWith();
  const digest = createHash("sha256").update(value(2000)).digest("hex");
  f.sql
    .prepare("INSERT INTO raw_capture_chunks VALUES(?,?,0,?)")
    .run(key(), digest, Buffer.from("corrupt"));
  await assert.rejects(f.store.put(key(), value(2000)), /readback differs/);
  assert.equal(f.selected(), prior);
});

test("lost selection acknowledgement can be retried without duplicate reservations", async () => {
  const f = fixture();
  f.failWith((text) => {
    if (text.startsWith("SELECT sha256 FROM raw_capture_selected"))
      throw new Error("lost acknowledgement");
  });
  await assert.rejects(f.store.put(key(), value()));
  assert(f.selected());
  f.failWith();
  await f.store.put(key(), value());
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    1,
  );
});

test("older capture invocations cannot replace newer selected data", async () => {
  const f = fixture();
  await f.store.put(key(), value(2000));
  const prior = f.selected();
  await assert.rejects(
    f.store.put(key(), value(1000)),
    /selection was not acknowledged/,
  );
  assert.equal(f.selected(), prior);
});

test("a full staging budget rejects new bytes before any incomplete selection", async () => {
  const f = fixture();
  f.sql.exec("UPDATE raw_capture_budget SET bytes=536870912");
  await assert.rejects(f.store.put(key(), value()), /CHECK constraint/);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM raw_capture_batches").get()?.n,
    0,
  );
  assert.equal(f.selected(), undefined);
});

test("invalid ranges and cross-network key spellings fail before reserving space", async () => {
  const f = fixture();
  for (const [objectKey, raw] of [
    [key().replace("000000000010.ndjson", "000000000011.ndjson"), value()],
    [key().replace("chain/raw/", "chain/testnet/raw/"), value()],
    [key(), value().replace('"block_number":10', '"block_number":11')],
  ])
    await assert.rejects(f.store.put(objectKey!, raw!));
  assert.equal(
    f.sql.prepare("SELECT objects FROM raw_capture_budget").get()?.objects,
    0,
  );
});

test("D1 selection with a missing database cannot fall through to an R2 writer", async () => {
  let writes = 0;
  const result = await runRawCaptureSync(
    {
      RAW_CAPTURE_ENABLED: "true",
      RAW_CAPTURE_STORAGE: "d1",
      METAGRAPH_ARCHIVE: {
        put: async () => {
          writes++;
        },
      },
    },
    { recordException: async () => false },
  );
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
});
