import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveObjectStore,
  withArchiveObjects,
} from "../src/archive-object-store.ts";
import {
  ACCOUNT_SUMMARY_POINTER_KEY,
  ACCOUNT_SUMMARY_SCHEMA_VERSION,
  loadAccountSummaryProjection,
} from "../src/account-summary-projection.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { RetainedHistoryUnavailableError } from "../src/retained-history-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.useRealTimers();
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
  let before:
    ((text: string, params: unknown[]) => void | Promise<void>) | undefined;
  type Result = { success: boolean; results: unknown[] };
  let reply: ((result: Result) => Result) | undefined;
  const prepare = (text: string, params: unknown[] = []) => ({
    bind(...values: unknown[]) {
      return prepare(text, values);
    },
    async all() {
      await before?.(text, params);
      const result = {
        success: true,
        results: sql.prepare(text).all(...(params as never[])),
      };
      return reply ? reply(result) : result;
    },
  });
  const legacy = {
    get: vi.fn(
      async (
        _key: string,
        _options?: R2GetOptions,
      ): Promise<R2ObjectBody | null> => null,
    ),
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
    reply(callback: typeof reply) {
      reply = callback;
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
  it("rejects malformed database responses and oversized or invalid descriptors", async () => {
    const f = fixture();
    f.reply(() => ({ success: false, results: [] }));
    await expect(f.store.head(key)).rejects.toThrow("query failed");
    for (const results of [
      [{ key: "unexpected", payload: "{}" }],
      [1, 2].map(() => ({ key: prefix + key, payload: "{}" })),
    ]) {
      f.reply(() => ({ success: true, results }));
      await expect(f.store.get(key)).rejects.toThrow("row census");
    }
    f.reply(undefined);
    f.set(prefix + key, { padding: "x".repeat(48 * 1024) });
    await expect(f.store.get(key)).rejects.toThrow("pointer exceeds");
    f.set(prefix + key, {
      ...f.record(Buffer.from("data")),
      metadata: { padding: "x".repeat(4096) },
    });
    await expect(f.store.head(key)).rejects.toThrow();
    f.set(prefix + key, {
      ...f.record(Buffer.from("data")),
      metadata: { Expires: "invalid date" },
    });
    await expect(f.store.head(key)).rejects.toThrow("expiry");
  });

  it("preserves stream consumption, metadata-only conditions and absent heads", async () => {
    const f = fixture(),
      raw = Buffer.from("payload");
    expect(await f.store.head(key)).toBeNull();
    expect(
      await archiveObjectStore({
        ...f.env,
        ARCHIVE_OBJECT_STORAGE: "native",
      }).head(key),
    ).toBeNull();
    f.set(prefix + key, f.record(raw));
    const headers = new Headers();
    (await f.store.head(key))!.writeHttpMetadata(headers);
    expect([...headers]).toEqual([]);
    expect(Buffer.from(await (await body(f.store)).bytes())).toEqual(raw);
    expect(await (await (await body(f.store)).blob()).text()).toBe("payload");
    const stream = await body(f.store);
    await stream.body.cancel();
    expect(stream.bodyUsed).toBe(true);
    for (const onlyIf of [
      { etagMatches: "*" },
      { etagDoesNotMatch: "other" },
      {},
    ]) {
      expect(await (await body(f.store, key, { onlyIf })).text()).toBe(
        "payload",
      );
    }
    for (const etagDoesNotMatch of ["*", hash(raw, "md5")]) {
      const value = await f.store.get(key, { onlyIf: { etagDoesNotMatch } });
      expect(value && "body" in value).toBe(false);
    }
  });

  it("rejects truncated, oversized and changed reconstructed bodies", async () => {
    const f = fixture(),
      raw = Buffer.from("data");
    for (const bytes of [3, 5]) {
      f.set(prefix + key, { ...f.record(raw), bytes });
      await expect((await body(f.store)).text()).rejects.toThrow(
        /budget|truncated/,
      );
    }
    const packed = gzipSync(raw),
      sha256 = hash(packed);
    const partKey = `archive-payload/v1/${sha256}/0`;
    f.set(prefix + key, {
      ...f.record(raw),
      body: { d1: { sha256, bytes: packed.length, parts: 1 } },
    });
    for (const data of [packed.subarray(1), Buffer.alloc(packed.length)]) {
      f.set(partKey, { data: data.toString("base64") });
      await expect((await body(f.store)).text()).rejects.toThrow(
        /length|compressed checksum/,
      );
    }
  });

  it("keeps immutable D1 chunks and pointer acknowledgments consistent under races", async () => {
    const f = fixture();
    f.fail((sql, params) => {
      if (
        sql.startsWith("INSERT") &&
        String(params[0]).startsWith("archive-payload/")
      )
        f.set(String(params[0]), { data: "changed" });
    });
    await expect(f.store.put(key, "a".repeat(1024 * 1024 + 1))).rejects.toThrow(
      "chunk readback",
    );
    expect(await f.store.head(key)).toBeNull();
    f.fail(undefined);
    f.set(prefix + key, f.record(Buffer.from("existing")));
    let update = false;
    f.fail((sql) => {
      if (sql.startsWith("UPDATE")) update = true;
      else if (update && sql.startsWith("SELECT"))
        f.set(prefix + key, f.record(Buffer.from("winner")));
    });
    await expect(f.store.put(key, "candidate")).rejects.toThrow(
      "selection changed",
    );
    f.fail(undefined);
    expect(await (await body(f.store)).text()).toBe("winner");
  });

  it("validates every native segment, chunk boundary and response before serving", async () => {
    const f = fixture(),
      raw = Buffer.from("abcdefgh"),
      sha256 = hash(raw),
      etag = hash(raw, "md5");
    const partKey = `archive-content/v1/${sha256}`,
      id = `native-object/v1/${bucket}/${partKey}`;
    const native = {
      version: 1,
      bucket,
      key: partKey,
      bytes: raw.length,
      sha256,
      etag,
      partition: "a",
      chunks: [{ sha256, bytes: raw.length }],
    };
    f.set(prefix + key, {
      ...f.record(raw),
      body: { parts: [{ key: partKey, bytes: raw.length, sha256, etag }] },
    });
    await expect((await body(f.store)).text()).rejects.toThrow(
      "part is missing",
    );
    for (const value of [
      { ...native, etag: "0".repeat(32) },
      {
        ...native,
        chunks: [
          { sha256, bytes: 3 },
          { sha256, bytes: 3 },
        ],
      },
      {
        ...native,
        chunks: [
          { sha256, bytes: 3 },
          { sha256, bytes: 3 },
          { sha256, bytes: 3 },
        ],
      },
      { ...native, partition: "b" },
    ]) {
      f.set(id, value);
      await expect((await body(f.store)).text()).rejects.toThrow(
        /identity|census|binding/,
      );
    }
    f.set(id, native);
    for (const response of [
      new Response(null),
      new Response(raw, { headers: { "content-encoding": "gzip" } }),
      new Response(raw, { headers: { "content-length": "7" } }),
    ]) {
      f.fetch.mockImplementationOnce(async () => response);
      await expect((await body(f.store)).text()).rejects.toThrow(
        "response differs",
      );
    }
    f.assets.set(`/${sha256}.mgpack`, raw);
    f.set(prefix + key, {
      ...f.record(raw),
      sha256: "0".repeat(64),
      body: { parts: [{ key: partKey, bytes: raw.length, sha256, etag }] },
    });
    await expect((await body(f.store)).text()).rejects.toThrow(
      "complete checksum",
    );
  });

  it("skips untouched segments for cross-segment ranges", async () => {
    const f = fixture(),
      first = Buffer.alloc(16 * 1024 * 1024, 65),
      last = Buffer.from("tail");
    const raw = Buffer.concat([first, last]);
    const parts = [first, last].map((raw) => {
      const sha256 = hash(raw),
        etag = hash(raw, "md5"),
        key = `archive-content/v1/${sha256}`;
      const chunks = [];
      for (let offset = 0; offset < raw.length; offset += 512 * 1024) {
        const chunk = raw.subarray(offset, offset + 512 * 1024),
          digest = hash(chunk);
        f.assets.set(`/${digest}.mgpack`, chunk);
        chunks.push({ sha256: digest, bytes: chunk.length });
      }
      f.set(`native-object/v1/${bucket}/${key}`, {
        version: 1,
        bucket,
        key,
        bytes: raw.length,
        sha256,
        etag,
        partition: "a",
        chunks,
      });
      return { key, bytes: raw.length, sha256, etag };
    });
    f.set(prefix + key, {
      ...f.record(Buffer.from("unused")),
      bytes: raw.length,
      sha256: hash(raw),
      etag: hash(raw, "md5"),
      body: { parts },
    });
    expect(
      await (
        await body(f.store, key, { range: { offset: first.length } })
      ).text(),
    ).toBe("tail");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(
      await (
        await body(f.store, key, { range: { offset: 0, length: 1 } })
      ).text(),
    ).toBe("A");
  });

  it("preserves Python inline bytes, metadata, ETag, time, conditions and ranges", async () => {
    const f = fixture(),
      raw = Buffer.from('{"height":123,"name":"retained"}');
    const record = {
      ...f.record(raw),
      metadata: {
        ContentType: "application/json",
        CacheControl: "max-age=60",
        Expires: "2026-10-01T12:00:00+00:00",
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
    expect(headers.get("expires")).toBe("Thu, 01 Oct 2026 12:00:00 GMT");
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

  it("conditionally refreshes only an unchanged existing source", async () => {
    const f = fixture();
    const source = f.record(Buffer.from("existing"));
    const options = { onlyIf: { etagMatches: source.etag } };
    expect(await f.store.put(key, "next", options)).toBeNull();
    f.set(prefix + key, { version: 1, bucket, key, deleted: true });
    expect(await f.store.put(key, "next", options)).toBeNull();
    f.set(prefix + key, source);
    expect(
      await f.store.put(key, "next", { onlyIf: { etagMatches: "stale" } }),
    ).toBeNull();
    expect(await (await body(f.store)).text()).toBe("existing");
    expect((await f.store.put(key, "next", options))?.etag).toBe(
      hash(Buffer.from("next"), "md5"),
    );
    expect(await (await body(f.store)).text()).toBe("next");
  });

  it("returns a conditional conflict for either CAS loss or post-write supersession", async () => {
    for (const phase of ["before", "after"]) {
      const f = fixture();
      const source = f.record(Buffer.from("existing"));
      f.set(prefix + key, source);
      let updated = false;
      f.fail((sql) => {
        if (sql.startsWith("UPDATE")) {
          updated = true;
          if (phase === "before")
            f.set(prefix + key, f.record(Buffer.from("winner")));
        } else if (phase === "after" && updated && sql.startsWith("SELECT")) {
          f.set(prefix + key, f.record(Buffer.from("winner")));
        }
      });
      expect(
        await f.store.put(key, "candidate", {
          onlyIf: { etagMatches: source.etag },
        }),
      ).toBeNull();
      f.fail(undefined);
      expect(await (await body(f.store)).text()).toBe("winner");
    }
  });

  it("does not treat a malformed conditional write acknowledgment as contention", async () => {
    for (const results of [
      [{ key: "wrong" }],
      [{ key: prefix + key }, { key: prefix + key }],
    ]) {
      const f = fixture();
      const source = f.record(Buffer.from("existing"));
      f.set(prefix + key, source);
      let updating = false;
      f.fail((sql) => {
        updating = sql.startsWith("UPDATE");
      });
      f.reply((result) => (updating ? { success: true, results } : result));
      await expect(
        f.store.put(key, "candidate", { onlyIf: { etagMatches: source.etag } }),
      ).rejects.toThrow("selection changed");
    }
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

function deferredArchiveRead<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function observeArchiveRead<T>(pending: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  void pending.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const SUMMARY_ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const SUMMARY_NOW = Date.parse("2026-08-14T11:00:00Z");

function summaryPointerBytes() {
  return Buffer.from(
    JSON.stringify({
      schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
      generation: "20260814T100000Z",
      shard_count: 16384,
      generated_at: "2026-08-14T10:00:00Z",
      account_count: 1,
    }),
  );
}

function nativeSummaryPointer(f: ReturnType<typeof fixture>) {
  const raw = summaryPointerBytes();
  const sha256 = hash(raw);
  const etag = hash(raw, "md5");
  const partKey = `archive-content/v1/${sha256}`;
  const middle = Math.ceil(raw.length / 2);
  const chunks = [raw.subarray(0, middle), raw.subarray(middle)];
  f.set(`native-object/v1/${bucket}/${partKey}`, {
    version: 1,
    bucket,
    key: partKey,
    bytes: raw.length,
    sha256,
    etag,
    partition: "a",
    chunks: chunks.map((chunk) => ({
      sha256: hash(chunk),
      bytes: chunk.length,
    })),
  });
  f.set(prefix + ACCOUNT_SUMMARY_POINTER_KEY, {
    ...f.record(raw),
    key: ACCOUNT_SUMMARY_POINTER_KEY,
    body: { parts: [{ key: partKey, bytes: raw.length, sha256, etag }] },
  });
  for (const chunk of chunks) f.assets.set(`/${hash(chunk)}.mgpack`, chunk);
  return chunks;
}

function boundedSummary(f: ReturnType<typeof fixture>) {
  const env = withArchiveObjects({
    ...f.env,
    METAGRAPH_R2_TIMEOUT_MS: "20",
  });
  return loadAccountSummaryProjection(env, SUMMARY_ACCOUNT, {
    now: () => SUMMARY_NOW,
  });
}

describe("the summary deadline through the native archive adapter", () => {
  function clock() {
    vi.useFakeTimers({
      now: SUMMARY_NOW,
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
  }

  it("a delayed D1 selection cannot continue into asset or legacy reads", async () => {
    clock();
    const f = fixture();
    nativeSummaryPointer(f);
    const held = deferredArchiveRead<void>();
    const queries: string[] = [];
    f.fail(async (_sql, params) => {
      queries.push(String(params[0]));
      if (params[0] === prefix + ACCOUNT_SUMMARY_POINTER_KEY)
        await held.promise;
    });
    const pending = boundedSummary(f);
    const outcome = observeArchiveRead(pending);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(outcome.settled, "SUMMARY_NATIVE_D1_EXCEEDED_DEADLINE").toBe(true);
      expect(outcome.error).toBeInstanceOf(RetainedHistoryUnavailableError);
      held.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(queries).toEqual([prefix + ACCOUNT_SUMMARY_POINTER_KEY]);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.legacy.get).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("a fetch ignoring abort cancels its late body without another chunk", async () => {
    clock();
    const f = fixture();
    const chunks = nativeSummaryPointer(f);
    const heldFetch = deferredArchiveRead<Response>();
    const heldCancel = deferredArchiveRead<void>();
    const cancel = vi.fn(() => heldCancel.promise);
    let signal: AbortSignal | undefined;
    f.fetch.mockImplementationOnce(async (request) => {
      signal = request.signal;
      return heldFetch.promise;
    });
    const late = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunks[0]);
          controller.close();
        },
        cancel,
      }),
    );
    const queries: string[] = [];
    f.fail((_sql, params) => {
      queries.push(String(params[0]));
    });
    const pending = boundedSummary(f);
    const outcome = observeArchiveRead(pending);
    try {
      await vi.advanceTimersByTimeAsync(19);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.settled, "SUMMARY_NATIVE_FETCH_IGNORED_DEADLINE").toBe(
        true,
      );
      expect(outcome.error).toBeInstanceOf(RetainedHistoryUnavailableError);
      expect(signal?.aborted).toBe(true);
      const readsAtDeadline = queries.length;
      heldFetch.resolve(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(queries).toHaveLength(readsAtDeadline);
      expect(f.legacy.get).not.toHaveBeenCalled();
    } finally {
      heldFetch.resolve(late);
      heldCancel.resolve();
      await pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("a stalled native body and hanging cancellation cannot extend the deadline", async () => {
    clock();
    const f = fixture();
    const chunks = nativeSummaryPointer(f);
    const heldCancel = deferredArchiveRead<void>();
    const cancel = vi.fn(() => heldCancel.promise);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    f.fetch.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
            cancel,
          }),
        ),
    );
    const pending = boundedSummary(f);
    const outcome = observeArchiveRead(pending);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(outcome.settled, "SUMMARY_NATIVE_BODY_CANCEL_HELD_DEADLINE").toBe(
        true,
      );
      expect(outcome.error).toBeInstanceOf(RetainedHistoryUnavailableError);
      expect(cancel).toHaveBeenCalledOnce();
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.legacy.get).not.toHaveBeenCalled();
    } finally {
      // Let the old unbounded reader finish when this test is run against the
      // baseline; a timed-out reader has already canceled this controller.
      if (cancel.mock.calls.length === 0) {
        controller.enqueue(chunks[0]);
        controller.close();
      }
      heldCancel.resolve();
      await pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("a late legacy get is canceled without waiting for its cancel promise", async () => {
    clock();
    const f = fixture();
    const heldGet = deferredArchiveRead<R2ObjectBody | null>();
    const heldCancel = deferredArchiveRead<void>();
    const cancel = vi.fn(() => heldCancel.promise);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(summaryPointerBytes());
          controller.close();
        },
        cancel,
      }),
    );
    const late = {
      body: response.body,
      json: () => response.json(),
    } as R2ObjectBody;
    f.legacy.get.mockImplementationOnce(async () => heldGet.promise);
    const pending = boundedSummary(f);
    const outcome = observeArchiveRead(pending);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(outcome.settled, "SUMMARY_LEGACY_GET_EXCEEDED_DEADLINE").toBe(
        true,
      );
      expect(outcome.error).toBeInstanceOf(RetainedHistoryUnavailableError);
      heldGet.resolve(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(f.legacy.get).toHaveBeenCalledOnce();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      heldGet.resolve(late);
      heldCancel.resolve();
      await pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("an invalid asset response declines promptly despite hanging cancellation", async () => {
    clock();
    const f = fixture();
    nativeSummaryPointer(f);
    const heldCancel = deferredArchiveRead<void>();
    const cancel = vi.fn(() => heldCancel.promise);
    f.fetch.mockImplementationOnce(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 502,
        }),
    );
    const pending = boundedSummary(f);
    const outcome = observeArchiveRead(pending);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome.settled, "SUMMARY_INVALID_ASSET_AWAITED_CANCEL").toBe(
        true,
      );
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.legacy.get).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      heldCancel.resolve();
      await pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("a legacy absence arriving after the deadline remains unavailable", async () => {
    clock();
    const f = fixture();
    const held = deferredArchiveRead<R2ObjectBody | null>();
    const queries: string[] = [];
    f.fail((_sql, params) => {
      queries.push(String(params[0]));
    });
    f.legacy.get.mockImplementationOnce(async () => held.promise);
    const pending = boundedSummary(f);
    const outcome = observeArchiveRead(pending);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toBeInstanceOf(RetainedHistoryUnavailableError);
      expect(outcome.value).toBeUndefined();
      held.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(queries).toEqual([prefix + ACCOUNT_SUMMARY_POINTER_KEY]);
      expect(f.legacy.get).toHaveBeenCalledOnce();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      held.resolve(null);
      await pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});
