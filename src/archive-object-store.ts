import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { markD1SqlExecution } from "./d1-store.ts";
import { timed, TIMING_D1 } from "./request-timing.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

const BUCKET = "metagraphed-artifacts";
const PREFIX = `archive-object/v1/${BUCKET}/`;
const PART = 16 * 1024 * 1024;
const CHUNK = 65536;
const INLINE = 24 * 1024;
const MAX_WRITE = 32 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const etag = z.string().regex(/^[a-f0-9]{32}(?:-[1-9][0-9]*)?$/);
const keySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_./:=+-]+$/)
  .refine((key) =>
    key
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."),
  );
const partSchema = z
  .strictObject({
    key: keySchema,
    bytes: z.number().int().positive().max(PART),
    etag: z.string().regex(/^[a-f0-9]{32}$/),
    sha256: hash,
  })
  .refine((part) => part.key === `archive-content/v1/${part.sha256}`);
const identity = z.object({
  version: z.literal(1),
  bucket: z.literal(BUCKET),
  key: keySchema,
});
const objectSchema = identity
  .extend({
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 ** 3),
    etag,
    sha256: hash,
    modified: z.string().datetime({ offset: true }),
    metadata: z.record(z.string(), z.unknown()),
    body: z.union([
      z.strictObject({ gzip: z.string().max(32768) }),
      z.strictObject({ parts: z.array(partSchema).min(1).max(128) }),
      z.strictObject({
        d1: z.strictObject({
          sha256: hash,
          bytes: z
            .number()
            .int()
            .positive()
            .max(MAX_WRITE + CHUNK),
          parts: z.number().int().positive().max(513),
        }),
      }),
    ]),
  })
  .strict()
  .refine((value) => {
    if (JSON.stringify(value.metadata).length > 4096) return false;
    if ("gzip" in value.body) return value.bytes <= 1024 * 1024;
    if ("d1" in value.body)
      return (
        value.bytes <= MAX_WRITE &&
        value.body.d1.parts === Math.ceil(value.body.d1.bytes / CHUNK)
      );
    return (
      value.body.parts.length === Math.ceil(value.bytes / PART) &&
      value.body.parts.every(
        (part, index) =>
          part.bytes === Math.min(PART, value.bytes - index * PART),
      )
    );
  });
const recordSchema = z.union([
  objectSchema,
  identity.extend({ deleted: z.literal(true) }).strict(),
]);
type ArchiveObject = z.infer<typeof objectSchema>;
const nativeSchema = z.strictObject({
  version: z.literal(1),
  bucket: z.literal(BUCKET),
  key: keySchema,
  bytes: z.number().int().positive().max(PART),
  sha256: hash,
  etag: z.string().regex(/^[a-f0-9]{32}$/),
  partition: z.string().regex(/^[a-f0-9]$/),
  chunks: z
    .array(
      z.strictObject({
        sha256: hash,
        bytes: z
          .number()
          .int()
          .positive()
          .max(512 * 1024),
      }),
    )
    .min(1)
    .max(256),
});
type Database = Pick<D1Database, "prepare">;
type ArchiveEnv = {
  ARCHIVE_OBJECT_STORAGE?: string;
  D1_STATE?: Database;
  METAGRAPH_ARCHIVE?: Pick<R2Bucket, "get" | "head">;
} & Record<string, unknown>;
const digest = (bytes: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");

async function exact(stream: ReadableStream<Uint8Array>, bytes: number) {
  const result = new Uint8Array(bytes),
    reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.length > bytes)
        throw new Error("Archive body exceeds its byte budget");
      result.set(next.value, offset);
      offset += next.value.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (offset !== bytes) throw new Error("Archive body is truncated");
  return result;
}

/** Existing D1 control rows select verified content in the existing 16 stores.
 * Missing selected content fails closed. Only an absent pointer can use the
 * transitional legacy reader; tombstones and corruption never fall back. */
export function archiveObjectStore(env: ArchiveEnv) {
  const db = env.D1_STATE;
  if (!db?.prepare) throw new Error("Archive object database is unavailable");
  const legacy =
    env.ARCHIVE_OBJECT_STORAGE === "native-read-legacy"
      ? env.METAGRAPH_ARCHIVE
      : undefined;
  async function query(sql: string, params: unknown[]) {
    const result = await timed(TIMING_D1, () =>
      db!
        .prepare(sql)
        .bind(...params)
        .all<{ key: string; payload: string }>(),
    );
    markD1SqlExecution(result);
    if (!result.success) throw new Error("Archive object query failed");
    return result.results;
  }
  async function readRows(keys: string[]) {
    const rows = await query(
      `SELECT key,payload FROM generated_artifacts WHERE key IN (${keys.map(() => "?").join(",")})`,
      keys,
    );
    if (
      rows.some((row) => !keys.includes(row.key)) ||
      new Set(rows.map((row) => row.key)).size !== rows.length
    )
      throw new Error("Archive row census differs");
    return new Map(rows.map((row) => [row.key, row.payload]));
  }
  async function selected(key: string) {
    keySchema.parse(key);
    const raw = (await readRows([PREFIX + key])).get(PREFIX + key);
    if (raw === undefined) return { raw: undefined, value: undefined };
    if (Buffer.byteLength(raw) > 48 * 1024)
      throw new Error("Archive pointer exceeds budget");
    const value = recordSchema.parse(JSON.parse(raw));
    if (value.key !== key) throw new Error("Archive pointer identity differs");
    return { raw, value };
  }
  async function compressed(
    body: Exclude<ArchiveObject["body"], { parts: unknown }>,
  ) {
    if ("gzip" in body) return Buffer.from(atob(body.gzip), "latin1");
    const item = body.d1,
      packed = new Uint8Array(item.bytes);
    let offset = 0;
    for (let start = 0; start < item.parts; start += 8) {
      const keys = Array.from(
        { length: Math.min(8, item.parts - start) },
        (_, index) => `archive-payload/v1/${item.sha256}/${start + index}`,
      );
      const rows = await readRows(keys);
      for (const key of keys) {
        const value = rows.get(key);
        if (value === undefined || value.length > 90 * 1024)
          throw new Error("Archive D1 chunk is missing or oversized");
        const chunk = z
          .strictObject({ data: z.string().max(87384) })
          .parse(JSON.parse(value));
        const raw = Buffer.from(atob(chunk.data), "latin1");
        if (raw.length !== Math.min(CHUNK, item.bytes - offset))
          throw new Error("Archive D1 chunk length differs");
        packed.set(raw, offset);
        offset += raw.length;
      }
    }
    if (digest(packed) !== item.sha256)
      throw new Error("Archive compressed checksum differs");
    return packed;
  }
  async function* bodyParts(
    object: ArchiveObject,
    offset: number,
    length: number,
  ): AsyncGenerator<Uint8Array> {
    if (!("parts" in object.body)) {
      const packed = await compressed(object.body);
      const raw = await exact(
        new Response(packed).body!.pipeThrough(new DecompressionStream("gzip")),
        object.bytes,
      );
      if (digest(raw) !== object.sha256)
        throw new Error("Archive restored checksum differs");
      yield raw.subarray(offset, offset + length);
      return;
    }
    const full =
      offset === 0 && length === object.bytes
        ? createHash("sha256")
        : undefined;
    for (const [index, part] of object.body.parts.entries()) {
      const partOffset = index * PART;
      if (partOffset >= offset + length || partOffset + part.bytes <= offset)
        continue;
      const key = `native-object/v1/${BUCKET}/${part.key}`;
      const raw = (await readRows([key])).get(key);
      if (raw === undefined || Buffer.byteLength(raw) > 64 * 1024)
        throw new Error("Archive native part is missing or oversized");
      const native = nativeSchema.parse(JSON.parse(raw));
      if (
        native.key !== part.key ||
        native.bytes !== part.bytes ||
        native.sha256 !== part.sha256 ||
        native.etag !== part.etag
      )
        throw new Error("Archive native part identity differs");
      const chunkSize = native.chunks[0].bytes;
      if (
        native.chunks.length !== Math.ceil(native.bytes / chunkSize) ||
        native.chunks.some(
          (chunk, i) =>
            chunk.bytes !== Math.min(chunkSize, native.bytes - i * chunkSize),
        )
      )
        throw new Error("Archive native chunk census differs");
      const binding = env[`NATIVE_HISTORY_ASSETS_${native.partition}`] as
        Pick<Fetcher, "fetch"> | undefined;
      if (!binding?.fetch) throw new Error("Archive native binding is missing");
      for (const [i, chunk] of native.chunks.entries()) {
        const start = partOffset + i * chunkSize;
        if (start >= offset + length || start + chunk.bytes <= offset) continue;
        const response = await binding.fetch(
          new Request(`https://history-assets.invalid/${chunk.sha256}.mgpack`, {
            headers: { "accept-encoding": "identity" },
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          }),
        );
        const header = response.headers.get("content-length");
        if (
          response.status !== 200 ||
          !response.body ||
          (response.headers.get("content-encoding") ?? "identity") !==
            "identity" ||
          (header !== null && header !== String(chunk.bytes))
        ) {
          await response.body?.cancel();
          throw new Error("Archive asset response differs");
        }
        const bytes = await exact(response.body, chunk.bytes);
        if (digest(bytes) !== chunk.sha256)
          throw new Error("Archive asset checksum differs");
        full?.update(bytes);
        yield bytes.subarray(
          Math.max(0, offset - start),
          Math.min(chunk.bytes, offset + length - start),
        );
      }
    }
    if (full && full.digest("hex") !== object.sha256)
      throw new Error("Archive complete checksum differs");
  }
  function head(object: ArchiveObject): R2Object {
    const mapping = {
      ContentType: "contentType",
      ContentLanguage: "contentLanguage",
      ContentDisposition: "contentDisposition",
      ContentEncoding: "contentEncoding",
      CacheControl: "cacheControl",
    } as const;
    const httpMetadata: R2HTTPMetadata = {};
    for (const [source, target] of Object.entries(mapping)) {
      if (typeof object.metadata[source] === "string")
        httpMetadata[target] = object.metadata[source];
    }
    if (typeof object.metadata.Expires === "string") {
      const expires = new Date(object.metadata.Expires);
      if (!Number.isFinite(expires.getTime()))
        throw new Error("Archive expiry metadata differs");
      httpMetadata.cacheExpiry = expires;
    }
    return {
      key: object.key,
      version: object.sha256,
      size: object.bytes,
      etag: object.etag,
      httpEtag: `"${object.etag}"`,
      uploaded: new Date(object.modified),
      storageClass: "Standard",
      httpMetadata,
      customMetadata: object.metadata.Metadata as
        Record<string, string> | undefined,
      checksums: {
        toJSON: () => ({
          sha256: Buffer.from(object.sha256, "hex").toString("base64"),
        }),
      },
      writeHttpMetadata(headers: Headers) {
        const names = {
          contentType: "content-type",
          contentLanguage: "content-language",
          contentDisposition: "content-disposition",
          contentEncoding: "content-encoding",
          cacheControl: "cache-control",
        } as const;
        for (const [key, header] of Object.entries(names)) {
          const value = httpMetadata[key as keyof typeof names];
          if (value !== undefined) headers.set(header, value);
        }
        if (httpMetadata.cacheExpiry)
          headers.set("expires", httpMetadata.cacheExpiry.toUTCString());
      },
    };
  }
  function range(options: R2GetOptions | undefined, size: number) {
    const value = options?.range;
    if (value instanceof Headers)
      throw new Error("Archive range headers are unsupported");
    const offset =
      value && "suffix" in value
        ? Math.max(0, size - value.suffix)
        : (value?.offset ?? 0);
    const length =
      value && "suffix" in value
        ? size - offset
        : (value?.length ?? size - offset);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > size
    )
      throw new Error("Archive range exceeds object");
    return { offset, length };
  }
  async function get(
    key: string,
    options?: R2GetOptions,
  ): Promise<R2ObjectBody | R2Object | null> {
    const { value } = await selected(key);
    if (value === undefined) return legacy?.get(key, options) ?? null;
    if ("deleted" in value) return null;
    if (options?.ssecKey)
      throw new Error("Archive customer encryption is unsupported");
    const metadata = head(value),
      condition = options?.onlyIf;
    if (
      condition instanceof Headers ||
      (condition &&
        Object.keys(condition).some(
          (name) => name !== "etagMatches" && name !== "etagDoesNotMatch",
        ))
    )
      throw new Error("Archive condition is unsupported");
    if (
      condition &&
      ((condition.etagMatches !== undefined &&
        condition.etagMatches !== value.etag &&
        condition.etagMatches !== "*") ||
        (condition.etagDoesNotMatch !== undefined &&
          (condition.etagDoesNotMatch === value.etag ||
            condition.etagDoesNotMatch === "*")))
    )
      return metadata;
    const { offset, length } = range(options, value.bytes);
    const iterator = bodyParts(value, offset, length);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() {
          await iterator.return(undefined);
        },
      }),
    );
    return {
      ...metadata,
      writeHttpMetadata: (headers: Headers) =>
        metadata.writeHttpMetadata(headers),
      ...(options?.range ? { range: { offset, length } } : {}),
      get body() {
        return response.body!;
      },
      get bodyUsed() {
        return response.bodyUsed;
      },
      arrayBuffer: () => response.arrayBuffer(),
      bytes: () => response.bytes(),
      text: () => response.text(),
      json: <T>() => response.json<T>(),
      blob: () => response.blob(),
    } satisfies R2ObjectBody;
  }
  async function put(
    key: string,
    value: string,
  ): Promise<ReturnType<typeof head>>;
  async function put(
    key: string,
    value: string,
    options: { onlyIf: { etagMatches: string } },
  ): Promise<ReturnType<typeof head> | null>;
  async function put(
    key: string,
    value: string,
    options?: { onlyIf: { etagMatches: string } },
  ) {
    keySchema.parse(key);
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_WRITE)
      throw new Error("Archive writer requires bounded text");
    const previous = await selected(key);
    const expected = options?.onlyIf.etagMatches;
    if (
      expected !== undefined &&
      (!previous.value ||
        "deleted" in previous.value ||
        previous.value.etag !== expected)
    )
      return null;
    const raw = new TextEncoder().encode(value);
    const packed = new Uint8Array(
      await new Response(
        new Response(raw).body!.pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    const sha256 = digest(raw),
      packedSha = digest(packed);
    let body: ArchiveObject["body"];
    if (raw.length <= 1024 * 1024 && packed.length <= INLINE)
      body = { gzip: Buffer.from(packed).toString("base64") };
    else {
      const parts = Math.ceil(packed.length / CHUNK);
      for (let i = 0; i < parts; i++) {
        const key = `archive-payload/v1/${packedSha}/${i}`;
        const payload = JSON.stringify({
          data: Buffer.from(
            packed.subarray(i * CHUNK, (i + 1) * CHUNK),
          ).toString("base64"),
        });
        await query(
          "INSERT INTO generated_artifacts(key,payload) VALUES(?,?) ON CONFLICT(key) DO NOTHING RETURNING key",
          [key, payload],
        );
        if ((await readRows([key])).get(key) !== payload)
          throw new Error("Archive immutable chunk readback differs");
      }
      body = { d1: { sha256: packedSha, bytes: packed.length, parts } };
    }
    const object = objectSchema.parse({
      version: 1,
      bucket: BUCKET,
      key,
      bytes: raw.length,
      etag: digest(raw, "md5"),
      sha256,
      modified: new Date().toISOString(),
      metadata: {},
      body,
    });
    const payload = JSON.stringify(object),
      id = PREFIX + key;
    const rows =
      previous.raw === undefined
        ? await query(
            "INSERT INTO generated_artifacts(key,payload) VALUES(?,?) ON CONFLICT(key) DO NOTHING RETURNING key",
            [id, payload],
          )
        : await query(
            "UPDATE generated_artifacts SET payload=?,updated_at=? WHERE key=? AND payload=? RETURNING key",
            [payload, object.modified, id, previous.raw],
          );
    if (rows.length === 0 && expected !== undefined) return null;
    if (rows.length !== 1 || rows[0].key !== id)
      throw new Error("Archive selection changed during write");
    if ((await selected(key)).raw !== payload) {
      if (expected !== undefined) return null;
      throw new Error("Archive selection changed during write");
    }
    return head(object);
  }
  return {
    get,
    put,
    async head(key: string) {
      const { value } = await selected(key);
      return value === undefined
        ? (legacy?.head(key) ?? null)
        : "deleted" in value
          ? null
          : head(value);
    },
  };
}

let environments = new WeakMap<object, object>();
registerModuleStateReset("src/archive-object-store.ts", () => {
  environments = new WeakMap();
});

/** One stable storage port for all existing website, API, MCP and cron readers. */
export function withArchiveObjects<T extends object>(env: T): T {
  const config = env as ArchiveEnv,
    mode = config.ARCHIVE_OBJECT_STORAGE;
  if (mode === undefined || mode === "r2") return env;
  if (mode !== "native" && mode !== "native-read-legacy")
    throw new Error("Unknown archive storage mode");
  const cached = environments.get(env);
  if (cached) return cached as T;
  const wrapped = { ...env, METAGRAPH_ARCHIVE: archiveObjectStore(config) };
  environments.set(env, wrapped);
  environments.set(wrapped, wrapped);
  return wrapped;
}
