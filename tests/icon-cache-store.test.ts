import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { iconCacheStore, MAX_ICON_BYTES } from "../src/icon-cache-store.ts";

test("icons retain exact bytes, metadata and shared negatives in the existing D1 store", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(
      readFileSync(
        new URL(
          "../migrations/d1/0027_generated_artifacts.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const db = {
      prepare(query: string) {
        return {
          bind(...values: string[]) {
            return {
              first: async () => sql.prepare(query).get(...values) ?? null,
            };
          },
        };
      },
    } as unknown as Pick<D1Database, "prepare">;
    const store = iconCacheStore(db)!;
    const key = "icon-cache/example.com/64";
    assert.equal(await store.get(key), null);
    const backing = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
    const image = backing.subarray(17, 917);
    const metadata = {
      httpMetadata: { contentType: "image/x-icon", cacheControl: "immutable" },
    };
    await store.put(key, image, metadata);
    const first = await iconCacheStore(db)!.get(key);
    assert.deepEqual(new Uint8Array(first!.body), image);
    assert.equal(first!.size, image.byteLength);
    assert.deepEqual(first!.httpMetadata, metadata.httpMetadata);
    assert.equal(first!.customMetadata, undefined);
    const maximum = new Uint8Array(MAX_ICON_BYTES).fill(255);
    await store.put(key, maximum.buffer, metadata);
    assert.deepEqual(new Uint8Array((await store.get(key))!.body), maximum);
    await assert.rejects(
      store.put(key, new Uint8Array(MAX_ICON_BYTES + 1), {}),
    );
    assert.deepEqual(new Uint8Array((await store.get(key))!.body), maximum);
    const negative = { negative: "transient", negative_at: "1790480000000" };
    await store.put(key, new Uint8Array(0), { customMetadata: negative });
    const second = await iconCacheStore(db)!.get(key);
    assert.equal(second!.size, 0);
    assert.equal(second!.body.byteLength, 0);
    assert.deepEqual(second!.customMetadata, negative);
    assert.equal(second!.httpMetadata, undefined);
    assert.equal(
      sql.prepare("SELECT COUNT(*) AS n FROM generated_artifacts").get()!.n,
      1,
    );

    const overwrite = (value: unknown) =>
      sql
        .prepare("UPDATE generated_artifacts SET payload=? WHERE key=?")
        .run(JSON.stringify(value), key);
    for (const value of [
      {},
      { data: 123 },
      { data: Buffer.alloc(MAX_ICON_BYTES + 3).toString("base64") },
      { data: Buffer.alloc(MAX_ICON_BYTES + 1).toString("base64") },
    ]) {
      overwrite(value);
      assert.equal(await store.get(key), null);
    }
    overwrite({ data: "%" });
    await assert.rejects(store.get(key));
  } finally {
    sql.close();
  }
  assert.equal(iconCacheStore(), undefined);
  assert.equal(iconCacheStore({} as D1Database), undefined);
});
