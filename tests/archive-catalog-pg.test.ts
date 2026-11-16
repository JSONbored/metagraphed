import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, afterEach, test } from "vitest";
import { createPgArchiveCatalog } from "../src/archive-catalog-pg.ts";
import { archiveObjectStore } from "../src/archive-object-store.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";

let db: PGlite;
beforeEach(async () => {
  db = new PGlite();
  await db.exec(
    readFileSync(
      new URL(
        "../migrations/postgres/0006_generated_artifacts.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
afterEach(async () => db.close());
function catalog() {
  const query = async <Row>(text: string, values: unknown[] = []) =>
    (await db.query<Row>(toPositionalPlaceholders(text), values)).rows;
  const runtime: Pick<PgStoreRuntime, "producer"> = {
    producer: {
      query,
      first: async <Row>(text: string, values?: unknown[]) =>
        (await query<Row>(text, values))[0] ?? null,
      run: async () => {
        throw new Error("Unexpected run");
      },
      transaction: async () => {
        throw new Error("Unexpected transaction");
      },
    },
  };
  return createPgArchiveCatalog(runtime);
}
async function text(
  store: ReturnType<typeof archiveObjectStore>,
  key: string,
  options?: R2GetOptions,
) {
  const result = await store.get(key, options);
  assert.ok(result && "body" in result);
  return result.text();
}

test("native catalog drives the existing object writer, conditional updates and ranges", async () => {
  const raw = catalog();
  const store = archiveObjectStore({ ARCHIVE_CATALOG_STORE: raw });
  assert.equal(await store.head("fixture/key"), null);
  const first = await store.put("fixture/key", "hello\0world");
  assert.equal(await text(store, "fixture/key"), "hello\0world");
  assert.equal(
    await text(store, "fixture/key", { range: { offset: 6, length: 5 } }),
    "world",
  );
  assert.equal(
    await store.put("fixture/key", "stale", {
      onlyIf: { etagMatches: "wrong" },
    }),
    null,
  );
  assert.ok(
    await store.put("fixture/key", "updated", {
      onlyIf: { etagMatches: first.etag },
    }),
  );
  assert.equal(await text(store, "fixture/key"), "updated");
  const large = randomBytes(40000).toString("base64");
  await store.put("fixture/large", large);
  assert.equal(await text(store, "fixture/large"), large);
  await raw.insert(
    "archive-object/v1/metagraphed-artifacts/deleted",
    JSON.stringify({
      version: 1,
      bucket: "metagraphed-artifacts",
      key: "deleted",
      deleted: true,
    }),
  );
  assert.equal(await store.get("deleted"), null);
  assert.equal(await store.head("deleted"), null);
});

test("native content is selected over asset bindings and corrupt selected content never falls back", async () => {
  const raw = catalog();
  const bytes = Buffer.from("immutable content"),
    hash = createHash("sha256").update(bytes).digest("hex"),
    etag = createHash("md5").update(bytes).digest("hex");
  const key = "fixture/content",
    part = `archive-content/v1/${hash}`;
  await raw.insert(
    `archive-object/v1/metagraphed-artifacts/${key}`,
    JSON.stringify({
      version: 1,
      bucket: "metagraphed-artifacts",
      key,
      bytes: bytes.length,
      etag,
      sha256: hash,
      modified: "2026-01-01T00:00:00Z",
      metadata: {},
      body: { parts: [{ key: part, bytes: bytes.length, etag, sha256: hash }] },
    }),
  );
  await raw.insert(
    `native-object/v1/metagraphed-artifacts/${part}`,
    JSON.stringify({
      version: 1,
      bucket: "metagraphed-artifacts",
      key: part,
      bytes: bytes.length,
      sha256: hash,
      etag,
      partition: "a",
      chunks: [{ sha256: hash, bytes: bytes.length }],
    }),
  );
  let requested = "";
  const store = archiveObjectStore({
    ARCHIVE_CATALOG_STORE: raw,
    ARCHIVE_CONTENT_STORE: {
      get: async (sha, signal) => {
        signal.throwIfAborted();
        requested = sha;
        return new Response(bytes);
      },
    },
    NATIVE_HISTORY_ASSETS_a: {
      fetch: () => {
        throw new Error("must not use assets");
      },
    },
  });
  assert.equal(await text(store, key), "immutable content");
  assert.equal(requested, hash);
  const corrupt = archiveObjectStore({
    ARCHIVE_CATALOG_STORE: raw,
    ARCHIVE_CONTENT_STORE: {
      get: async () => new Response(Buffer.alloc(bytes.length)),
    },
  });
  await assert.rejects(text(corrupt, key), /checksum/);
});

test("malformed explicit native capabilities are rejected instead of selecting legacy state", () => {
  for (const candidate of [null, {}, { read() {} }, { read() {}, insert() {} }])
    assert.throws(
      () => archiveObjectStore({ ARCHIVE_CATALOG_STORE: candidate as never }),
      /catalog store/,
    );
  for (const candidate of [null, {}])
    assert.throws(
      () =>
        archiveObjectStore({
          ARCHIVE_CATALOG_STORE: catalog(),
          ARCHIVE_CONTENT_STORE: candidate as never,
        }),
      /content store/,
    );
});
