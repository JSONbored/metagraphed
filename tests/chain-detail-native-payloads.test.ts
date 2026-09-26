import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  NATIVE_PAYLOAD_PREFIX as prefix,
  readNativePayload,
} from "../src/chain-detail-native-payloads.ts";
import {
  restoreChainDetailPayloads,
  storeChainDetailPayloads,
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
          };
        },
      };
    },
  };
  return { sql, env: { D1_STATE: db } };
}
function seed(sql: DatabaseSync, bytes: Uint8Array, digest: string) {
  for (let i = 0; i * 1_490_000 < bytes.length; i++)
    sql
      .prepare("INSERT INTO chain_detail_payload_chunks VALUES (?, ?, ?)")
      .run(
        digest,
        i,
        Buffer.from(
          bytes.subarray(i * 1_490_000, (i + 1) * 1_490_000),
        ).toString("base64"),
      );
}

for (const encoding of ["gzip", "raw"] as const) {
  test(`native ${encoding} chunks restore exact UTF-8 through the shared reader`, async () => {
    const f = fixture();
    try {
      const value = "\uFEFF" + "界abc".repeat(300_000);
      const raw = Buffer.from(value),
        bytes = encoding === "gzip" ? gzipSync(raw) : raw;
      const h = hash(raw);
      seed(f.sql, bytes, h);
      const ref = `${prefix}${h}:${raw.length}:${bytes.length}:${encoding}:d1`;
      const rows = [{ args: ref }, { call_args: ref }];
      assert.deepEqual(await restoreChainDetailPayloads(f.env, rows), [
        { args: value },
        { call_args: value },
      ]);
    } finally {
      f.sql.close();
    }
  });
}

test("the full sixteen-megabyte payload is preserved across twelve D1 chunks", async () => {
  const f = fixture();
  try {
    const value = "x".repeat(16 * 1024 * 1024),
      bytes = Buffer.from(value),
      h = hash(bytes);
    seed(f.sql, bytes, h);
    assert.deepEqual(
      await restoreChainDetailPayloads(f.env, [
        { args: `${prefix}${h}:${bytes.length}:${bytes.length}:raw:d1` },
      ]),
      [{ args: value }],
    );
  } finally {
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
});

test("missing, misordered and corrupt chunks fail closed", async () => {
  const f = fixture(),
    bytes = new Uint8Array(140000),
    h = hash(bytes);
  try {
    await assert.rejects(
      readNativePayload(f.env, h, bytes.length, "d1"),
      /Missing/,
    );
    seed(f.sql, bytes, h);
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
      restoreChainDetailPayloads(f.env, [
        { args: `${prefix}${h}:140000:140000:raw:d1` },
      ]),
      /Corrupt/,
    );
  } finally {
    f.sql.close();
  }
});

test("inline native reads preserve BOM and replay without storage bindings", async () => {
  const value = "\uFEFF" + "界".repeat(60000),
    raw = Buffer.from(value),
    bytes = gzipSync(raw);
  const ref = `${prefix}${hash(raw)}:${raw.length}:${bytes.length}:gzip:inline:${bytes.toString("base64")}`;
  assert.deepEqual(
    await restoreChainDetailPayloads(null, [{ args: ref }, { call_args: ref }]),
    [{ args: value }, { call_args: value }],
  );
  await assert.rejects(
    storeChainDetailPayloads(null, [{ args: prefix + "bad" }]),
    /Reserved/,
  );
});
