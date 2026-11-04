import assert from "node:assert/strict";
import { test } from "vitest";
import { Buffer } from "node:buffer";
import { createPgKv } from "../src/pg-kv.ts";
import {
  appKv,
  consumeKvText,
  oauthPendingKv,
  type AppKv,
} from "../src/app-kv.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";

function fixture() {
  const rows = new Map<
    string,
    {
      namespace: string;
      key: Buffer;
      value: Buffer;
      metadata: string | null;
      expires_at: number | null;
    }
  >();
  let time = 100_000;
  let calls = 0;
  const identity = (namespace: unknown, key: unknown) =>
    `${namespace}:${(key as Buffer).toString("hex")}`;
  const producer: PgStoreRuntime["producer"] = {
    async first<Row>(text: string, values: unknown[] = []) {
      calls += 1;
      const consuming = text.startsWith("DELETE");
      const [limit, namespace, key, now] = consuming
        ? [values[3], ...values.slice(0, 3)]
        : values;
      const id = identity(namespace, key);
      const row = rows.get(id);
      if (!row || (row.expires_at !== null && row.expires_at <= Number(now)))
        return null;
      if (consuming) rows.delete(id);
      return {
        value: row.value.length > Number(limit) ? null : Buffer.from(row.value),
        size: row.value.length,
      } as Row;
    },
    async run(text: string, values: unknown[] = []) {
      calls += 1;
      const [namespace, key, value, metadata, expires] = values;
      const id = identity(namespace, key);
      if (text.startsWith("DELETE"))
        return { changes: Number(rows.delete(id)) };
      rows.set(id, {
        namespace: String(namespace),
        key: Buffer.from(key as Buffer),
        value: Buffer.from(value as Buffer),
        metadata: metadata as string | null,
        expires_at: expires as number | null,
      });
      return { changes: 1 };
    },
    async query<Row>(_text: string, values: unknown[] = []) {
      calls += 1;
      const [namespace, now, lower, upper, , after, , count] = values;
      return [...rows.values()]
        .filter(
          (row) =>
            row.namespace === namespace &&
            (row.expires_at === null || row.expires_at > Number(now)) &&
            Buffer.compare(row.key, lower as Buffer) >= 0 &&
            (!upper || Buffer.compare(row.key, upper as Buffer) < 0) &&
            (!after || Buffer.compare(row.key, after as Buffer) > 0),
        )
        .sort((left, right) => Buffer.compare(left.key, right.key))
        .slice(0, Number(count)) as Row[];
    },
    async transaction() {
      throw new Error("unused");
    },
  };
  return {
    runtime: { producer },
    rows,
    calls: () => calls,
    now: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

test("byte values and all application read representations preserve their contracts", async () => {
  const f = fixture();
  const kv = createPgKv(f.runtime, "control", { now: f.now });
  await kv.put("json", JSON.stringify({ ready: true }));
  assert.deepEqual(await kv.get("json", "json"), { ready: true });
  assert.deepEqual(await kv.get("json", { type: "json" }), { ready: true });
  assert.equal(await kv.get("missing"), null);
  assert.equal(await kv.get("json", "text"), '{"ready":true}');
  assert.equal(
    await kv.get("json", { type: "text", cacheTtl: 30 }),
    '{"ready":true}',
  );
  const bytes = new Uint8Array([0, 255, 194, 1]);
  await kv.put("nul\0key", bytes.subarray(1, 3));
  assert.deepEqual(
    new Uint8Array((await kv.get("nul\0key", "arrayBuffer"))!),
    bytes.subarray(1, 3),
  );
  assert.deepEqual(
    new Uint8Array((await kv.get("nul\0key", { type: "arrayBuffer" }))!),
    bytes.subarray(1, 3),
  );
  assert.equal(await kv.get("nul\0key"), "��");
  await assert.rejects(kv.get("nul\0key", "json"));
  assert.deepEqual(
    new Uint8Array(
      await new Response(await kv.get("nul\0key", "stream")).arrayBuffer(),
    ),
    bytes.subarray(1, 3),
  );
  assert.ok(await kv.get("nul\0key", { type: "stream" }));
  await kv.put("buffer", bytes.buffer);
  assert.deepEqual(
    new Uint8Array((await kv.get("buffer", "arrayBuffer"))!),
    bytes,
  );
  await kv.put("empty", "");
  assert.equal(await kv.get("empty"), "");
  await kv.delete("buffer");
  assert.equal(await kv.get("buffer"), null);
});

test("writes collect bounded streams and cancel refused input without replacing prior data", async () => {
  const f = fixture();
  const kv = createPgKv(f.runtime, "control", { maxValueBytes: 4 });
  await kv.put(
    "stream",
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }),
  );
  assert.deepEqual(
    new Uint8Array((await kv.get("stream", "arrayBuffer"))!),
    new Uint8Array([1, 2, 3, 4]),
  );
  let cancelled = false;
  await assert.rejects(
    kv.put(
      "stream",
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
    /byte budget/,
  );
  assert.equal(cancelled, true);
  await assert.rejects(kv.put("stream", "12345"), /byte budget/);
  await assert.rejects(
    kv.put(
      "bad",
      new ReadableStream({
        start(controller) {
          controller.enqueue("text");
        },
      }),
    ),
    /contain bytes/,
  );
  await assert.rejects(kv.put("bad", 1 as never), /text or bytes/);
  assert.equal((await kv.get("stream", "arrayBuffer"))!.byteLength, 4);
});

test("expiry is invisible at its boundary and an overwrite clears old expiry and metadata", async () => {
  const f = fixture();
  const kv = createPgKv(f.runtime, "control", { now: f.now });
  await kv.put("a", "old", {
    expirationTtl: 60,
    metadata: { a: [1, true, null] },
  });
  assert.equal(await kv.get("a"), "old");
  assert.deepEqual((await kv.list()).keys, [
    { name: "a", expiration: 160, metadata: { a: [1, true, null] } },
  ]);
  f.advance(60_000);
  assert.equal(await kv.get("a"), null);
  assert.equal(await kv.consume!("a"), null);
  assert.deepEqual((await kv.list()).keys, []);
  await kv.put("a", "new");
  assert.deepEqual((await kv.list()).keys, [{ name: "a" }]);
  await kv.put("absolute", "v", { expiration: 200 });
  f.advance(40_000);
  assert.equal(await kv.get("absolute"), null);
  for (const settings of [
    { expiration: 1 },
    { expiration: Infinity },
    { expirationTtl: 59 },
    { expirationTtl: 60.5 },
    { expiration: 201, expirationTtl: 60 },
  ]) {
    await assert.rejects(kv.put("bad", "v", settings));
  }
});

test("metadata and UTF-8 limits reject values that would change silently", async () => {
  const f = fixture();
  const kv = createPgKv(f.runtime, "control", { maxKeyBytes: 4 });
  for (const metadata of [
    NaN,
    -0,
    { lost: undefined },
    { n: Infinity },
    new Date(),
    [, 1],
    { [Symbol("s")]: 1 },
    "x".repeat(1024),
  ]) {
    await assert.rejects(kv.put("key", "v", { metadata }));
  }
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(kv.put("key", "v", { metadata: circular }));
  await kv.put("éé", "ok", { metadata: ["é", 0, null] });
  assert.equal(await kv.get("éé"), "ok");
  for (const key of ["", "12345", "\ud800"])
    await assert.rejects(kv.put(key, "v"));
  for (const selected of [
    { maxValueBytes: 0 },
    { maxKeyBytes: 513 },
    { maxListKeys: 1001 },
    { maxListKeys: 1.5 },
  ]) {
    assert.throws(() => createPgKv(f.runtime, "control", selected));
  }
  assert.throws(() => createPgKv(f.runtime, ""));
  assert.throws(() => createPgKv(f.runtime, "n\0s"));
  assert.throws(() => kv.get("key", "invalid" as "text"));
});

test("prefix keysets preserve byte order and bind cursors to namespace, prefix and valid keys", async () => {
  const f = fixture();
  const kv = createPgKv(f.runtime, "control", { now: f.now });
  for (const key of ["b", "aé", "aa", "a\0", "a", "az"]) await kv.put(key, key);
  const first = await kv.list({ prefix: "a", limit: 2 });
  assert.deepEqual(
    first.keys.map((key) => key.name),
    ["a", "a\0"],
  );
  assert.equal(first.list_complete, false);
  const next = await kv.list({ prefix: "a", limit: 2, cursor: first.cursor });
  assert.deepEqual(
    next.keys.map((key) => key.name),
    ["aa", "az"],
  );
  const last = await kv.list({ prefix: "a", cursor: next.cursor });
  assert.deepEqual(
    last.keys.map((key) => key.name),
    ["aé"],
  );
  assert.equal(last.list_complete, true);
  await assert.rejects(kv.list({ prefix: "b", cursor: first.cursor }), /scope/);
  await assert.rejects(
    createPgKv(f.runtime, "other").list({ prefix: "a", cursor: first.cursor }),
    /scope/,
  );
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const cursor of [
    "=",
    "A",
    "a".repeat(4097),
    encode(null),
    encode([2, "control", "a", "YQ"]),
    encode([1, "control", "a", "Yg"]),
    encode([1, "control", "a", "Yf8"]),
  ]) {
    await assert.rejects(kv.list({ prefix: "a", cursor }));
  }
  for (const limit of [0, 1001, 1.5]) await assert.rejects(kv.list({ limit }));
});

test("native consumption and selection retain one-time and legacy behavior", async () => {
  const f = fixture();
  const kv = createPgKv(f.runtime, "control");
  await kv.put("nonce", "value");
  const results = await Promise.all([
    kv.consume!("nonce"),
    kv.consume!("nonce"),
  ]);
  assert.deepEqual(results.sort(), [null, "value"].sort());
  assert.equal(appKv({ CONTROL_KV_STORE: kv, METAGRAPH_CONTROL: {} }), kv);
  assert.equal(appKv({ METAGRAPH_CONTROL: kv }), kv);
  assert.equal(appKv(undefined), undefined);
  assert.equal(
    oauthPendingKv({ OAUTH_PENDING_STORE: kv, OAUTH_KV: {} as AppKv }),
    kv,
  );
  assert.equal(oauthPendingKv({ OAUTH_KV: kv }), kv);
  await kv.put("nonce", "next");
  assert.equal(await consumeKvText(kv, "nonce"), "next");
  const legacy = { get: kv.get, delete: kv.delete };
  await kv.put("nonce", "legacy");
  assert.equal(await consumeKvText(legacy, "nonce"), "legacy");
  assert.equal(await consumeKvText(legacy, "nonce"), null);
});

test("a stricter reader declines preexisting larger values before transfer", async () => {
  const f = fixture();
  await createPgKv(f.runtime, "control").put("large", "12345");
  const small = createPgKv(f.runtime, "control", { maxValueBytes: 4 });
  await assert.rejects(small.get("large"), /byte budget/);
  await assert.rejects(small.consume!("large"), /byte budget/);
});
