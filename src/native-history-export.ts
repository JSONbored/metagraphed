import { internalJson as reply } from "./internal-json.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { NATIVE_HISTORY_ASSET_OBJECT_KEY } from "../schemas-src/artifacts/native-history-assets.ts";
import { historyAssetSource } from "./history-asset-source.ts";

const head = z
  .object({
    kind: z.literal("native-history"),
    operation: z.literal("head"),
    key: z.string().max(1024).regex(NATIVE_HISTORY_ASSET_OBJECT_KEY),
    release: z
      .string()
      .max(71)
      .regex(/^[a-f0-9]{64}:[1-9]\d{0,5}$/)
      .refine((value) => Number(value.split(":")[1]) <= 512 * 1024)
      .optional(),
  })
  .strict();
const inputSchema = z.discriminatedUnion("operation", [
  head,
  head.extend({ operation: z.literal("verify") }),
  head.omit({ key: true }).extend({
    operation: z.literal("heads"),
    keys: z.array(head.shape.key).min(1).max(64),
    verify: z.literal(true).optional(),
  }),
  head.omit({ key: true }).extend({
    operation: z.literal("footers"),
    keys: z.array(head.shape.key.endsWith(".parquet")).min(1).max(16),
    footerBytes: z.union([z.literal(65536), z.literal(131072)]).optional(),
  }),
  head.extend({
    operation: z.literal("range"),
    etag: z.string().regex(/^[a-f0-9]{32}$/),
    offset: z
      .number()
      .int()
      .min(0)
      .max(128 * 1024 * 1024 - 1),
    length: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
  }),
]);

/** Authenticated, bounded native reads preserve identities without R2 fallback. */
export async function handleNativeHistoryExport(
  input: unknown,
  env: unknown,
): Promise<Response> {
  const fail = (status: number, error: string) => reply({ error }, status);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    return fail(400, "invalid native history export request");
  const value = parsed.data;
  if (
    (value.operation === "heads" || value.operation === "footers") &&
    new Set(value.keys).size !== value.keys.length
  )
    return fail(400, "duplicate native history keys");
  if (
    value.operation === "footers" &&
    value.keys.length * (value.footerBytes ?? 65536) > 1048576
  )
    return fail(400, "native footer batch exceeds byte budget");
  try {
    const source = historyAssetSource(
      value.release
        ? {
            ...(env as Record<string, unknown>),
            NATIVE_HISTORY_ASSET_RELEASE: value.release,
          }
        : env,
      {
        read: async () => {
          throw new Error("Native export cannot read an unmapped source");
        },
      },
      "NATIVE_HISTORY",
    );
    if (!source.describe)
      return fail(503, "native history export is not provisioned");
    const describe = source.describe;
    type NativeObject = NonNullable<Awaited<ReturnType<typeof describe>>>;
    let verifiedBytes = 0;
    async function verify(object: NativeObject) {
      // Hash bounded ranges near storage, sharing the request-scoped reader.
      verifiedBytes += object.bytes;
      if (verifiedBytes > 128 * 1024 * 1024)
        throw new Error("Native verification batch exceeds byte budget");
      const sha = createHash("sha256"),
        md5 = createHash("md5");
      for (let offset = 0; offset < object.bytes; offset += 8 * 1024 * 1024) {
        const bytes = new Uint8Array(
          await source.read(
            object.key,
            object.etag,
            offset,
            Math.min(8 * 1024 * 1024, object.bytes - offset),
          ),
        );
        sha.update(bytes);
        md5.update(bytes);
      }
      return (
        sha.digest("hex") === object.sha256 && md5.digest("hex") === object.etag
      );
    }
    if (value.operation === "heads" || value.operation === "footers") {
      const keys = value.keys;
      const objects: (
        (NativeObject & { offset?: number; data?: string }) | null
      )[] = new Array(keys.length);
      let cursor = 0,
        failed = false;
      // One authenticated request shares release/shard metadata across its
      // bounded batch. Stop queued reads on error and drain started work.
      await Promise.allSettled(
        Array.from({ length: Math.min(4, keys.length) }, async () => {
          while (!failed && cursor < keys.length) {
            const index = cursor++;
            try {
              const object = await describe(keys[index]);
              if (object && !object.sha256)
                throw new Error("Unqualified native checksum");
              if (
                value.operation === "heads" &&
                value.verify &&
                (!object || !(await verify(object)))
              )
                throw new Error("Native verification failed");
              if (value.operation === "footers") {
                if (!object) throw new Error("Native footer is not migrated");
                const length = Math.min(
                  value.footerBytes ?? 65536,
                  object.bytes,
                );
                const offset = object.bytes - length;
                const raw = await source.read(
                  object.key,
                  object.etag,
                  offset,
                  length,
                );
                if (raw.byteLength !== length)
                  throw new Error("Native footer is truncated");
                objects[index] = {
                  ...object,
                  offset,
                  data: Buffer.from(raw).toString("base64"),
                };
              } else {
                objects[index] = object ?? null;
              }
            } catch {
              failed = true;
            }
          }
        }),
      );
      if (failed)
        return fail(502, "native history static source is unavailable");
      return reply({
        version: 1,
        objects,
        ...(value.operation === "heads" && value.verify
          ? { verified: true }
          : {}),
      });
    }
    const object = await describe(value.key);
    if (!object) return fail(404, "native history object is not migrated");
    if (!object.sha256)
      return fail(503, "native history source checksum is unavailable");
    if (value.operation === "verify") {
      if (!(await verify(object)))
        return fail(502, "native history original checksum mismatch");
      return reply({ version: 1, object, verified: true });
    }
    if (value.operation === "head") return reply({ version: 1, object });
    const { key, etag, offset, length } = value;
    if (etag !== object.etag)
      return fail(412, "native history original identity changed");
    if (offset + length > object.bytes)
      return fail(416, "native history range exceeds the original object");
    const raw = await source.read(key, etag, offset, length);
    return new Response(raw, {
      status: 206,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "content-length": String(length),
        "content-range": `bytes ${offset}-${offset + length - 1}/${object.bytes}`,
        etag: `"${object.etag}"`,
        "x-history-sha256": object.sha256,
      },
    });
  } catch {
    return fail(502, "native history static source is unavailable");
  }
}
