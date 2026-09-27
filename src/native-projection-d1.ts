import { z } from "zod";

const CHUNK_BYTES = 65_536;
const MAX_BYTES = 32 * 1024 * 1024;
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
  return {
    async get(key: string) {
      const row = await db
        .prepare("SELECT payload FROM generated_artifacts WHERE key=?")
        .bind(key)
        .first<{ payload: string }>();
      if (!row) return null;
      if (key.endsWith("/current.json")) {
        return {
          size: new TextEncoder().encode(row.payload).byteLength,
          json: async () => JSON.parse(row.payload) as unknown,
        };
      }
      const descriptor = Descriptor.parse(JSON.parse(row.payload));
      if (
        descriptor.parts !== Math.ceil(descriptor.compressedBytes / CHUNK_BYTES)
      )
        throw new Error("Projection chunk census differs");
      let part = 0;
      const compressed = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (part === descriptor.parts) {
            controller.close();
            return;
          }
          const chunk = await db
            .prepare("SELECT payload FROM generated_artifacts WHERE key=?")
            .bind(`${key}/chunks/${part}`)
            .first<{ payload: string }>();
          if (!chunk) throw new Error("Projection chunk is missing");
          const data = (JSON.parse(chunk.payload) as { data: string }).data;
          if (typeof data !== "string" || data.length > 87_384)
            throw new Error("Projection chunk exceeds its budget");
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
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          ) as unknown,
      };
    },
  };
}
