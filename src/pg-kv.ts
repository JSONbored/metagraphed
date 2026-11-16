import { Buffer } from "node:buffer";
import type { AppKv } from "./app-kv.ts";
import type { PgTransaction, PgTransactionRunner } from "./pg-pool.ts";

type Representation = "text" | "json" | "arrayBuffer" | "stream";
interface StoredEntry {
  value: Buffer | null;
  size: number;
}
interface ListedEntry {
  key: Buffer;
  expires_at: number | null;
  metadata: string | null;
}
export interface PgKvOptions {
  maxValueBytes?: number;
  maxKeyBytes?: number;
  maxListKeys?: number;
  streamTimeoutMs?: number;
  /** Millisecond clock, injectable for deterministic expiry tests. */
  now?: () => number;
}
export interface PgKvRuntime {
  producer: PgTransaction;
  transaction: PgTransactionRunner;
}

const defaults = {
  maxValueBytes: 25 * 1024 * 1024,
  maxKeyBytes: 512,
  maxListKeys: 1000,
  streamTimeoutMs: 30_000,
};
const decoder = new TextDecoder();

function utf8(
  value: string,
  limit: number,
  label: string,
  allowEmpty = false,
): Buffer {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const bytes = Buffer.from(value, "utf8");
  if (
    (!allowEmpty && bytes.length === 0) ||
    bytes.length > limit ||
    bytes.toString("utf8") !== value
  ) {
    throw new RangeError(`${label} exceeds its UTF-8 contract`);
  }
  return bytes;
}

function metadataText(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > 1024)
    throw new RangeError("KV metadata exceeds its JSON contract");
  // Refuse silent JSON value changes such as nonfinite numbers and undefined
  // object members. Exact JSON source whitespace is not a metadata value.
  const check = (original: unknown, parsed: unknown): boolean => {
    if (original === null || typeof original !== "object")
      return Object.is(original, parsed);
    if (Array.isArray(original))
      return (
        Array.isArray(parsed) &&
        original.length === parsed.length &&
        Object.keys(original).length === original.length &&
        original.every((item, index) => check(item, parsed[index]))
      );
    if (
      Object.getPrototypeOf(original) !== Object.prototype &&
      Object.getPrototypeOf(original) !== null
    )
      return false;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return false;
    const expected = Object.entries(original);
    return (
      Object.getOwnPropertySymbols(original).length === 0 &&
      expected.length === Object.keys(parsed).length &&
      expected.every(([key, item]) =>
        check(item, (parsed as Record<string, unknown>)[key]),
      )
    );
  };
  if (!check(value, JSON.parse(text)))
    throw new TypeError("KV metadata must preserve its JSON value");
  return text;
}

async function valueBytes(
  value: Parameters<AppKv["put"]>[1],
  limit: number,
  timeoutMs: number,
): Promise<Buffer> {
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const output = Buffer.allocUnsafe(limit);
    let size = 0;
    const deadline = Date.now() + timeoutMs;
    const expired = new Error("KV stream read deadline exceeded");
    let timer!: ReturnType<typeof setTimeout>;
    try {
      for (;;) {
        if (Date.now() >= deadline) throw expired;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(expired), deadline - Date.now());
        });
        const next = await Promise.race([reader.read(), timeout]);
        clearTimeout(timer);
        if (next.done) return Buffer.from(output.subarray(0, size));
        if (!(next.value instanceof Uint8Array))
          throw new TypeError("KV stream must contain bytes");
        if (size + next.value.byteLength > limit)
          throw new RangeError("KV value exceeds its byte budget");
        output.set(next.value, size);
        size += next.value.byteLength;
      }
    } catch (error) {
      // Cancellation may itself stall in a producer. Observe its failure
      // without extending the caller's deadline.
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
  let bytes: Buffer;
  if (typeof value === "string") bytes = Buffer.from(value, "utf8");
  else if (value instanceof ArrayBuffer) bytes = Buffer.from(value).subarray();
  else if (ArrayBuffer.isView(value))
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else throw new TypeError("KV value must be text or bytes");
  if (bytes.length > limit)
    throw new RangeError("KV value exceeds its byte budget");
  return Buffer.from(bytes);
}

/** A bounded namespace over the process pool; every stored payload retains its
 * bytes and expiry. Authentication consumers opt into atomic consumption. */
export function createPgKv(
  runtime: PgKvRuntime,
  namespace: string,
  options: PgKvOptions = {},
): AppKv {
  utf8(namespace, 128, "KV namespace");
  if (namespace.includes("\0"))
    throw new TypeError("KV namespace cannot contain NUL");
  const limits = { ...defaults, ...options };
  for (const name of [
    "maxValueBytes",
    "maxKeyBytes",
    "maxListKeys",
    "streamTimeoutMs",
  ] as const) {
    if (
      !Number.isSafeInteger(limits[name]) ||
      limits[name] <= 0 ||
      limits[name] > defaults[name]
    ) {
      throw new RangeError(`Invalid KV ${name}`);
    }
  }
  const now = () => Math.floor((options.now ?? Date.now)() / 1000);
  const keyBytes = (key: string) => utf8(key, limits.maxKeyBytes, "KV key");
  const storedBytes = (row: StoredEntry): Uint8Array => {
    if (row.value === null || row.size > limits.maxValueBytes)
      throw new RangeError("Stored KV value exceeds its byte budget");
    return new Uint8Array(row.value);
  };
  const read = async (
    key: string,
    representation: Representation,
  ): Promise<unknown> => {
    const row = await runtime.producer.first<StoredEntry>(
      "SELECT CASE WHEN octet_length(value)<=? THEN value END AS value,octet_length(value) AS size " +
        "FROM auth.kv_entries WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)",
      [limits.maxValueBytes, namespace, keyBytes(key), now()],
    );
    if (row === null) return null;
    const bytes = storedBytes(row);
    if (representation === "arrayBuffer") return bytes.buffer;
    if (representation === "stream")
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    const text = decoder.decode(bytes);
    return representation === "json" ? JSON.parse(text) : text;
  };
  const get = ((
    key: string,
    selected?: Representation | { type?: Representation },
  ) => {
    const representation =
      typeof selected === "string" ? selected : (selected?.type ?? "text");
    if (!["text", "json", "arrayBuffer", "stream"].includes(representation))
      throw new TypeError("Unsupported KV representation");
    return read(key, representation);
  }) as AppKv["get"];
  return {
    get,
    async put(key, value, settings = {}) {
      const encoded = keyBytes(key);
      const metadata = metadataText(settings.metadata);
      if (
        settings.expiration !== undefined &&
        settings.expirationTtl !== undefined
      )
        throw new TypeError("KV expiry options are mutually exclusive");
      if (
        settings.expirationTtl !== undefined &&
        (!Number.isSafeInteger(settings.expirationTtl) ||
          settings.expirationTtl < 60)
      )
        throw new RangeError("KV TTL must be at least 60 whole seconds");
      const bytes = await valueBytes(
        value,
        limits.maxValueBytes,
        limits.streamTimeoutMs,
      );
      const current = now();
      const expiry =
        settings.expiration ??
        (settings.expirationTtl === undefined
          ? null
          : current + settings.expirationTtl);
      if (
        expiry !== null &&
        (!Number.isSafeInteger(expiry) || expiry <= current)
      )
        throw new RangeError("KV expiry must be a future second");
      await runtime.producer.run(
        "INSERT INTO auth.kv_entries(namespace,key,value,metadata,expires_at) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,metadata=excluded.metadata,expires_at=excluded.expires_at",
        [namespace, encoded, bytes, metadata, expiry],
      );
    },
    async delete(key) {
      await runtime.producer.run(
        "DELETE FROM auth.kv_entries WHERE namespace=? AND key=?",
        [namespace, keyBytes(key)],
      );
    },
    async consume(key) {
      const encoded = keyBytes(key);
      return runtime.transaction(async (tx) => {
        const row = await tx.first<StoredEntry>(
          "SELECT CASE WHEN octet_length(value)<=? THEN value END AS value,octet_length(value) AS size " +
            "FROM auth.kv_entries WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?) FOR UPDATE",
          [limits.maxValueBytes, namespace, encoded, now()],
        );
        if (row === null) return null;
        const value = decoder.decode(storedBytes(row));
        await tx.run(
          "DELETE FROM auth.kv_entries WHERE namespace=? AND key=?",
          [namespace, encoded],
        );
        return value;
      });
    },
    async list(settings = {}) {
      const prefix = settings.prefix ?? "";
      const encoded = utf8(prefix, limits.maxKeyBytes, "KV prefix", true);
      const upper = encoded.length === 0 ? null : Buffer.from(encoded);
      if (upper) upper[upper.length - 1] += 1;
      const limit = settings.limit ?? limits.maxListKeys;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > limits.maxListKeys
      )
        throw new RangeError("Invalid KV list limit");
      let after: Buffer | null = null;
      if (settings.cursor) {
        const raw = settings.cursor;
        if (
          raw.length > 8192 ||
          !/^[A-Za-z0-9_-]+$/.test(raw) ||
          Buffer.from(raw, "base64url").toString("base64url") !== raw
        )
          throw new TypeError("Invalid KV cursor");
        const cursor: unknown = JSON.parse(
          Buffer.from(raw, "base64url").toString("utf8"),
        );
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 4 ||
          cursor[0] !== 1 ||
          cursor[1] !== namespace ||
          cursor[2] !== prefix ||
          typeof cursor[3] !== "string"
        )
          throw new TypeError("KV cursor scope differs");
        after = Buffer.from(cursor[3], "base64url");
        if (
          after.toString("base64url") !== cursor[3] ||
          !after.subarray(0, encoded.length).equals(encoded)
        )
          throw new TypeError("Invalid KV cursor key");
        if (!after.equals(keyBytes(after.toString("utf8"))))
          throw new TypeError("Invalid KV cursor encoding");
      }
      const rows = await runtime.producer.query<ListedEntry>(
        "SELECT key,metadata,expires_at FROM auth.kv_entries WHERE namespace=? " +
          "AND (expires_at IS NULL OR expires_at>?) AND key>=? AND (?::bytea IS NULL OR key<?) " +
          "AND (?::bytea IS NULL OR key>?) ORDER BY key LIMIT ?",
        [namespace, now(), encoded, upper, upper, after, after, limit + 1],
      );
      const selected = rows.slice(0, limit);
      const keys = selected.map((row) => ({
        name: row.key.toString("utf8"),
        ...(row.expires_at === null ? {} : { expiration: row.expires_at }),
        ...(row.metadata === null
          ? {}
          : { metadata: JSON.parse(row.metadata) as unknown }),
      }));
      const complete = rows.length <= limit;
      return {
        keys,
        list_complete: complete,
        ...(complete
          ? {}
          : {
              cursor: Buffer.from(
                JSON.stringify([
                  1,
                  namespace,
                  prefix,
                  selected.at(-1)!.key.toString("base64url"),
                ]),
              ).toString("base64url"),
            }),
      };
    },
  };
}
