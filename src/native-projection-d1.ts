import { Buffer } from "node:buffer";
import { z } from "zod";
import { timed, TIMING_D1 } from "./request-timing.ts";
import { markD1SqlExecution } from "./d1-store.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

type ProjectionObject = {
  size: number;
  etag?: string;
  json(): Promise<unknown>;
};
type CacheEntry = {
  until: number;
  bytes: number;
  value: Promise<ProjectionObject | null>;
};
const CACHE_BYTES = 8 * 1024 * 1024;
const IMMUTABLE_KEY =
  /^metagraph\/native-projections\/v1\/(?:mainnet|testnet)\/[a-f0-9]{64}\/[a-z-]+\.json$/;
let caches = new WeakMap<
  object,
  { entries: Map<string, CacheEntry>; bytes: number }
>();
registerModuleStateReset("src/native-projection-d1.ts", () => {
  caches = new WeakMap();
});

/** Reuse verified immutable bytes, never a mutable pointer or parsed JSON.
 * Both the retained bytes and entry count are bounded per database binding.
 * The short lifetime also forces periodic storage revalidation. */
async function cachedProjection(
  db: object,
  key: string,
  load: () => Promise<ProjectionObject | null>,
): Promise<ProjectionObject | null> {
  if (!IMMUTABLE_KEY.test(key)) return load();
  let cache = caches.get(db);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    caches.set(db, cache);
  }
  const state = cache;
  const evict = (key: string) => {
    state.bytes -= state.entries.get(key)!.bytes;
    state.entries.delete(key);
  };
  const prior = state.entries.get(key);
  if (prior) {
    if (prior.until > Date.now()) {
      state.entries.delete(key);
      state.entries.set(key, prior);
      return prior.value;
    }
    evict(key);
  }
  if (state.entries.size >= 64) evict(state.entries.keys().next().value!);
  const entry = { until: Date.now() + 30_000, bytes: 0, value: load() };
  state.entries.set(key, entry);
  try {
    const object = await entry.value;
    if (state.entries.get(key) === entry) {
      if (!object || object.size > CACHE_BYTES) evict(key);
      else {
        entry.bytes = object.size;
        state.bytes += object.size;
        while (state.bytes > CACHE_BYTES)
          evict(state.entries.keys().next().value!);
      }
    }
    return object;
  } catch (error) {
    if (state.entries.get(key) === entry) evict(key);
    throw error;
  }
}

const CHUNK_BYTES = 65_536;
// Bound each binding response to 1 MiB of compressed bytes. Restore in order
// without paying one sequential database round trip per 64 KiB chunk.
const CHUNKS_PER_READ = 16;
const MAX_BYTES = 32 * 1024 * 1024;
const Chunk = z.strictObject({ data: z.string().max(87_384) });
const Descriptor = z.strictObject({
  format: z.literal("gzip-json-v1"),
  bytes: z.number().int().positive().max(MAX_BYTES),
  compressedBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTES + CHUNK_BYTES),
  parts: z.number().int().positive().max(513),
  etag: z.string().regex(/^[a-f0-9]{32}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Immutable compressed projections in the existing small-artifact table. */
export function nativeProjectionD1(db: Pick<D1Database, "prepare">) {
  const read = async (keys: string[]) => {
    const result = await timed(TIMING_D1, () =>
      db
        .prepare(
          `SELECT key,payload FROM generated_artifacts WHERE key IN (${keys.map(() => "?").join(",")})`,
        )
        .bind(...keys)
        .all<{ key: string; payload: string }>(),
    );
    markD1SqlExecution(result);
    return new Map(result.results.map((row) => [row.key, row.payload]));
  };
  const restore = async (key: string): Promise<ProjectionObject | null> => {
    const payload = (await read([key])).get(key);
    if (payload === undefined) return null;
    if (key.endsWith("/current.json")) {
      return {
        size: new TextEncoder().encode(payload).byteLength,
        json: async () => JSON.parse(payload) as unknown,
      };
    }
    const descriptor = Descriptor.parse(JSON.parse(payload));
    if (
      descriptor.parts !== Math.ceil(descriptor.compressedBytes / CHUNK_BYTES)
    )
      throw new Error("Projection chunk census differs");
    let part = 0;
    let chunks = new Map<string, string>();
    const compressed = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (part === descriptor.parts) {
          controller.close();
          return;
        }
        if (part % CHUNKS_PER_READ === 0)
          chunks = await read(
            Array.from(
              { length: Math.min(CHUNKS_PER_READ, descriptor.parts - part) },
              (_, index) => `${key}/chunks/${part + index}`,
            ),
          );
        const chunk = chunks.get(`${key}/chunks/${part}`);
        if (chunk === undefined) throw new Error("Projection chunk is missing");
        const { data } = Chunk.parse(JSON.parse(chunk));
        // atob retains strict base64 validation; the native byte copy avoids
        // an allocation/callback iteration for every compressed byte.
        const bytes = Buffer.from(atob(data), "latin1");
        const expected = Math.min(
          CHUNK_BYTES,
          descriptor.compressedBytes - part * CHUNK_BYTES,
        );
        if (bytes.length !== expected)
          throw new Error("Projection compressed byte census differs");
        part++;
        controller.enqueue(bytes);
      },
    });
    const reader = compressed
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    const body = new Uint8Array(descriptor.bytes);
    let offset = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.length > body.length)
          throw new Error("Projection expanded byte budget exceeded");
        body.set(chunk.value, offset);
        offset += chunk.value.length;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (offset !== body.length || digest !== descriptor.sha256)
      throw new Error("Projection restored identity differs");
    return {
      size: descriptor.bytes,
      etag: descriptor.etag,
      json: async () =>
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            body,
          ),
        ) as unknown,
    };
  };
  return {
    get: (key: string) => cachedProjection(db, key, () => restore(key)),
  };
}
