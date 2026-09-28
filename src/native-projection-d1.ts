import { z } from "zod";
import { timed, TIMING_D1 } from "./request-timing.ts";
import { markD1SqlExecution } from "./d1-store.ts";

const CHUNK_BYTES = 65_536;
// Bound each binding response to 512 KiB of compressed bytes. Restore in order
// without paying one sequential database round trip per 64 KiB chunk.
const CHUNKS_PER_READ = 8;
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
  return {
    async get(key: string) {
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
          if (chunk === undefined)
            throw new Error("Projection chunk is missing");
          const { data } = Chunk.parse(JSON.parse(chunk));
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
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
    },
  };
}
