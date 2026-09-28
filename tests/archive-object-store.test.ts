import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveObjectStore,
  withArchiveObjects,
} from "../src/archive-object-store.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  resetModuleState();
});
const bucket = "metagraphed-artifacts",
  prefix = `archive-object/v1/${bucket}/`,
  key = "metagraph/projections/example.json";
const hash = (bytes: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
function fixture() {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec(
    "CREATE TABLE generated_artifacts(key TEXT PRIMARY KEY,payload TEXT,updated_at TEXT)",
  );
  let before: ((text: string, params: unknown[]) => void) | undefined;
  const prepare = (text: string, params: unknown[] = []) => ({
    bind(...values: unknown[]) {
      return prepare(text, values);
    },
    async all() {
      before?.(text, params);
      return {
        success: true,
        results: sql.prepare(text).all(...(params as never[])),
      };
    },
  });
  const legacy = {
    get: vi.fn(async () => null),
    head: vi.fn(async () => null),
  };
  const assets = new Map<string, Uint8Array>();
  const fetch = vi.fn(
    async (request: Request) =>
      new Response(assets.get(new URL(request.url).pathname) ?? null, {
        status: assets.has(new URL(request.url).pathname) ? 200 : 404,
      }),
  );
  const env = {
    ARCHIVE_OBJECT_STORAGE: "native-read-legacy",
    D1_STATE: { prepare } as unknown as D1Database,
    METAGRAPH_ARCHIVE: legacy as unknown as R2Bucket,
    NATIVE_HISTORY_ASSETS_a: { fetch },
  };
  const set = (id: string, value: unknown) =>
    sql
      .prepare(
        "INSERT INTO generated_artifacts(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
      )
      .run(id, JSON.stringify(value));
  function record(raw: Uint8Array) {
    return {
      version: 1,
      bucket,
      key,
      bytes: raw.length,
      etag: hash(raw, "md5"),
      sha256: hash(raw),
      modified: "2026-09-28T00:00:00+00:00",
      metadata: {},
      body: { gzip: gzipSync(raw).toString("base64") },
    };
  }
  return {
    sql,
    legacy,
    assets,
    fetch,
    env,
    set,
    record,
    store: archiveObjectStore(env),
    fail(callback: typeof before) {
      before = callback;
    },
  };
}
async function body(
  store: ReturnType<typeof archiveObjectStore>,
  name = key,
  options?: R2GetOptions,
) {
  const value = await store.get(name, options);
  if (!value || !("body" in value)) throw new Error("Expected object body");
  return value;
}

describe("shared archive object storage", () => {
  it("preserves Python inline bytes, metadata, ETag, time, conditions and ranges", async () => {
    const f = fixture(),
      raw = Buffer.from('{"height":123,"name":"retained"}');
    const record = {
      ...f.record(raw),
      metadata: {
        ContentType: "application/json",
        CacheControl: "max-age=60",
        Metadata: { source: "original" },
      },
    };
    f.set(prefix + key, record);
    const object = await body(f.store);
    expect(await object.json()).toEqual({ height: 123, name: "retained" });
    expect(object.bodyUsed).toBe(true);
    expect(object.etag).toBe(record.etag);
    expect(object.uploaded.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(object.customMetadata).toEqual({ source: "original" });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cache-control")).toBe("max-age=60");
    expect(object.checksums.toJSON().sha256).toBe(
      Buffer.from(record.sha256, "hex").toString("base64"),
    );
    for (const [range, expected] of [
      [{ offset: 1, length: 3 }, raw.subarray(1, 4)],
      [{ suffix: 3 }, raw.subarray(-3)],
      [{ offset: raw.length }, Buffer.alloc(0)],
    ] as const) {
      const result = await body(f.store, key, {
        range,
        onlyIf: { etagMatches: record.etag },
      });
      expect(Buffer.from(await result.arrayBuffer())).toEqual(expected);
    }
    const refused = await f.store.get(key, {
      onlyIf: { etagMatches: "different" },
    });
    expect(refused && "body" in refused).toBe(false);
    expect(f.legacy.get).not.toHaveBeenCalled();
  });

  it("keeps fallback only for absent records and never revives tombstones or corruption", async () => {
    const f = fixture();
    expect(await f.store.get(key)).toBeNull();
    expect(f.legacy.get).toHaveBeenCalledOnce();
    f.set(prefix + key, { version: 1, bucket, key, deleted: true });
    expect(await f.store.get(key)).toBeNull();
    expect(await f.store.head(key)).toBeNull();
    expect(f.legacy.get).toHaveBeenCalledOnce();
    f.set(prefix + key, {
      ...f.record(Buffer.from("payload")),
      sha256: "0".repeat(64),
    });
    await expect((await body(f.store)).text()).rejects.toThrow("checksum");
    f.set(prefix + key, { ...f.record(Buffer.from("payload")), key: "wrong" });
    await expect(f.store.get(key)).rejects.toThrow("identity");
    expect(f.legacy.get).toHaveBeenCalledOnce();
    const native = archiveObjectStore({
      ...f.env,
      ARCHIVE_OBJECT_STORAGE: "native",
    });
    expect(await native.get("absent")).toBeNull();
    expect(f.legacy.get).toHaveBeenCalledOnce();
  });

  it("reads immutable assets in order and verifies cross-chunk ranges and full content", async () => {
    const f = fixture(),
      raw = Buffer.from("abcdefghij"),
      sha256 = hash(raw),
      etag = hash(raw, "md5");
    const partKey = `archive-content/v1/${sha256}`;
    const chunks = [raw.subarray(0, 4), raw.subarray(4, 8), raw.subarray(8)];
    const native = {
      version: 1,
      bucket,
      key: partKey,
      bytes: raw.length,
      sha256,
      etag,
      partition: "a",
      chunks: chunks.map((raw) => ({ sha256: hash(raw), bytes: raw.length })),
    };
    for (const bytes of chunks) f.assets.set(`/${hash(bytes)}.mgpack`, bytes);
    f.set(`native-object/v1/${bucket}/${partKey}`, native);
    f.set(prefix + key, {
      ...f.record(raw),
      body: { parts: [{ key: partKey, bytes: raw.length, sha256, etag }] },
    });
    expect(await (await body(f.store)).text()).toBe("abcdefghij");
    f.fetch.mockClear();
    expect(
      await (
        await body(f.store, key, { range: { offset: 3, length: 3 } })
      ).text(),
    ).toBe("def");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const path = `/${hash(chunks[0])}.mgpack`;
    f.assets.set(path, Buffer.from("fake"));
    await expect((await body(f.store)).text()).rejects.toThrow("checksum");
    f.assets.delete(path);
    await expect((await body(f.store)).text()).rejects.toThrow("response");
    expect(f.legacy.get).not.toHaveBeenCalled();
  });

  it("writes mutable projections to existing D1, selects last, and reads both encodings", async () => {
    const f = fixture();
    for (const text of [
      "",
      '{"version":1}',
      "a".repeat(1024 * 1024 + 1),
      randomBytes(40000).toString("hex"),
    ]) {
      const object = await f.store.put(key, text);
      expect(object.size).toBe(Buffer.byteLength(text));
      expect(await (await body(f.store)).text()).toBe(text);
      expect((await f.store.head(key))?.etag).toBe(object.etag);
    }
    const previous = f.sql
      .prepare("SELECT payload FROM generated_artifacts WHERE key=?")
      .get(prefix + key)!.payload;
    f.fail((sql) => {
      if (sql.startsWith("UPDATE generated_artifacts"))
        throw new Error("write interrupted");
    });
    await expect(f.store.put(key, "next")).rejects.toThrow("interrupted");
    expect(
      f.sql
        .prepare("SELECT payload FROM generated_artifacts WHERE key=?")
        .get(prefix + key)!.payload,
    ).toBe(previous);
    expect(f.legacy.get).not.toHaveBeenCalled();
  });

  it("rejects corrupt or missing D1 chunks and a competing pointer selection", async () => {
    const f = fixture();
    await f.store.put(key, "a".repeat(1024 * 1024 + 1));
    f.sql.exec(
      "DELETE FROM generated_artifacts WHERE key LIKE 'archive-payload/%'",
    );
    await expect((await body(f.store)).text()).rejects.toThrow("missing");
    f.fail((sql) => {
      if (sql.startsWith("UPDATE generated_artifacts"))
        f.set(prefix + key, f.record(Buffer.from("concurrent")));
    });
    await expect(f.store.put(key, "next")).rejects.toThrow("selection changed");
    expect(await (await body(f.store)).text()).toBe("concurrent");
  });

  it("bounds keys, descriptors, write sizes, ranges and unsupported options", async () => {
    const f = fixture();
    for (const key of ["../escape", "/absolute", "p//x", "", "a".repeat(1025)])
      await expect(f.store.get(key)).rejects.toThrow();
    f.set(prefix + key, f.record(Buffer.from("1234")));
    for (const range of [
      { offset: -1 },
      { offset: 0, length: 5 },
      { offset: 0.5 },
      new Headers(),
    ])
      await expect(f.store.get(key, { range })).rejects.toThrow();
    await expect(f.store.get(key, { onlyIf: new Headers() })).rejects.toThrow();
    await expect(
      f.store.get(key, { onlyIf: { uploadedBefore: new Date() } }),
    ).rejects.toThrow();
    await expect(f.store.get(key, { ssecKey: "secret" })).rejects.toThrow();
    await expect(
      f.store.put(key, "x".repeat(32 * 1024 * 1024 + 1)),
    ).rejects.toThrow("bounded");
    expect(() => archiveObjectStore({})).toThrow("database");
  });

  it("wraps all existing consumers with a stable port only after explicit selection", async () => {
    const f = fixture();
    const plain = {
      D1_STATE: f.env.D1_STATE,
      METAGRAPH_ARCHIVE: f.env.METAGRAPH_ARCHIVE,
    };
    expect(withArchiveObjects(plain)).toBe(plain);
    const wrapped = withArchiveObjects(f.env);
    expect(withArchiveObjects(f.env)).toBe(wrapped);
    expect(withArchiveObjects(wrapped)).toBe(wrapped);
    await wrapped.METAGRAPH_ARCHIVE.put(key, "selected");
    expect(await (await body(f.store)).text()).toBe("selected");
    expect(() =>
      withArchiveObjects({ ...f.env, ARCHIVE_OBJECT_STORAGE: "typo" }),
    ).toThrow("Unknown");
  });
});
