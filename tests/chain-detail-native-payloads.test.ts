import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  NATIVE_PAYLOAD_PREFIX as prefix,
  readNativePayload,
  writeNativePayload,
} from "../src/chain-detail-native-payloads.ts";
import {
  storeChainDetailPayloads,
  restoreChainDetailPayloads,
} from "../src/chain-detail-payloads.ts";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL(
        "../migrations/d1/0024_chain_detail_payload_chunks.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const db = {
    prepare(text: string) {
      return {
        bind(...values: (string | number)[]) {
          return {
            async all() {
              return { results: sql.prepare(text).all(...values) };
            },
            async run() {
              return sql.prepare(text).run(...values);
            },
          };
        },
      };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      sql.exec("BEGIN");
      try {
        for (const s of statements) await s.run();
        sql.exec("COMMIT");
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
      return [];
    },
  };
  return { env: { D1_STATE: db }, db, sql };
}

function rawCodec() {
  vi.stubGlobal(
    "CompressionStream",
    class extends TransformStream {
      constructor() {
        super({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });
      }
    },
  );
}

test("incompressible calls use bounded immutable D1 chunks and round trip exact UTF-8", async () => {
  const f = fixture();
  rawCodec();
  try {
    const value = "\uFEFF" + "界abc".repeat(300_000);
    const rows = [{ args: value }, { call_args: value }];
    const stored = await storeChainDetailPayloads(f.env, rows);
    assert.match(String(stored[0].args), /:raw:d1$/);
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM chain_detail_payload_chunks").get()!
        .n,
      2,
    );
    assert.deepEqual(await restoreChainDetailPayloads(f.env, stored), rows);
    assert.deepEqual(await storeChainDetailPayloads(f.env, rows), stored);
    const max = f.sql
      .prepare("SELECT max(length(data)) n FROM chain_detail_payload_chunks")
      .get()!.n;
    assert.equal(max, 1986668);
  } finally {
    vi.unstubAllGlobals();
    f.sql.close();
  }
});

test("gzip values too large to inline retain compressed bytes in D1", async () => {
  const f = fixture();
  // Distinct hashes make deterministic, poorly compressible valid text.
  const value = Array.from({ length: 6000 }, (_, i) =>
    hash(new TextEncoder().encode(String(i))),
  ).join("");
  const rows = [{ args: value }];
  const stored = await storeChainDetailPayloads(f.env, rows);
  assert.match(String(stored[0].args), /:gzip:d1$/);
  assert.deepEqual(await restoreChainDetailPayloads(f.env, stored), rows);
  f.sql.close();
});

test("maximum admitted payload spans twelve bounded chunks without an R2 binding", async () => {
  const f = fixture();
  rawCodec();
  try {
    const value = "x".repeat(16 * 1024 * 1024);
    const stored = await storeChainDetailPayloads(f.env, [{ args: value }]);
    assert.equal(
      f.sql.prepare("SELECT count(*) n FROM chain_detail_payload_chunks").get()!
        .n,
      12,
    );
    assert.deepEqual(await restoreChainDetailPayloads(f.env, stored), [
      { args: value },
    ]);
  } finally {
    vi.unstubAllGlobals();
    f.sql.close();
  }
});

test("native references reject malformed locations and sizes before reading", async () => {
  const h = "a".repeat(64);
  for (const suffix of [
    "bad",
    `${h}:0:1:raw:d1`,
    `${h}:1:1:zip:d1`,
    `${h}:1:1:raw:other`,
  ])
    await assert.rejects(
      restoreChainDetailPayloads(null, [{ args: prefix + suffix }]),
      /Invalid/,
    );
  for (const suffix of [
    `${h}:9007199254740992:1:raw:d1`,
    `${h}:1:9007199254740992:raw:d1`,
    `${h}:16777217:1:raw:d1`,
    `${h}:1:16777217:raw:d1`,
  ])
    await assert.rejects(
      restoreChainDetailPayloads(null, [{ args: prefix + suffix }]),
      /byte budget/,
    );
  await assert.rejects(readNativePayload(null, h, 1, "d1"), /unbound/);
  await assert.rejects(
    writeNativePayload(null, h, 140000, new Uint8Array(140000), "raw"),
    /unbound/,
  );
});

test("inline bytes enforce canonical base64 and declared length", async () => {
  const h = hash(new Uint8Array([0]));
  assert.deepEqual(
    await readNativePayload(null, h, 1, "inline:AA=="),
    new Uint8Array([0]),
  );
  await assert.rejects(
    readNativePayload(null, h, 1, "inline:" + "A".repeat(131076)),
    /byte budget/,
  );
  await assert.rejects(readNativePayload(null, h, 1, "inline:A"), /Truncated/);
  await assert.rejects(readNativePayload(null, h, 1, "inline:AAAA"), /Corrupt/);
  await assert.rejects(readNativePayload(null, h, 1, "inline:AB=="), /Corrupt/);
  await assert.rejects(
    restoreChainDetailPayloads(null, [
      { args: `${prefix}${h}:1:1:raw:inline:AQ==` },
    ]),
    /Corrupt/,
  );
  const raw = new Uint8Array([1, 2, 3]);
  assert.deepEqual(await readNativePayload(null, h, 3, "inline:AQID"), raw);
  assert.equal(
    await writeNativePayload(null, h, 3, raw, "raw"),
    `${prefix}${h}:3:3:raw:inline:AQID`,
  );
});

test("missing, misordered, corrupt or conflicting chunks fail closed", async () => {
  const f = fixture(),
    bytes = new Uint8Array(140000),
    h = hash(bytes);
  await assert.rejects(
    readNativePayload(f.env, h, bytes.length, "d1"),
    /Missing/,
  );
  await writeNativePayload(f.env, h, bytes.length, bytes, "raw");
  f.sql.prepare("UPDATE chain_detail_payload_chunks SET part=1").run();
  await assert.rejects(
    readNativePayload(f.env, h, bytes.length, "d1"),
    /ordering/,
  );
  f.sql
    .prepare("UPDATE chain_detail_payload_chunks SET part=0, data='AAAA'")
    .run();
  await assert.rejects(
    readNativePayload(f.env, h, bytes.length, "d1"),
    /Truncated/,
  );
  f.sql
    .prepare("UPDATE chain_detail_payload_chunks SET data=?")
    .run(Buffer.from(new Uint8Array(140000).fill(1)).toString("base64"));
  await assert.rejects(
    writeNativePayload(f.env, h, bytes.length, bytes, "raw"),
    /conflict/,
  );
  await assert.rejects(
    restoreChainDetailPayloads(f.env, [
      { args: `${prefix}${h}:140000:140000:raw:d1` },
    ]),
    /Corrupt/,
  );
  f.sql.close();
});

test("a failed chunk transaction cannot publish a reference", async () => {
  const f = fixture();
  vi.spyOn(f.db, "batch").mockRejectedValueOnce(new Error("unavailable"));
  await assert.rejects(
    writeNativePayload(
      f.env,
      "a".repeat(64),
      140000,
      new Uint8Array(140000),
      "raw",
    ),
    /unavailable/,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM chain_detail_payload_chunks").get()!
      .n,
    0,
  );
  f.sql.close();
});
