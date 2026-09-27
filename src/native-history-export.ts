import { internalJson as reply } from "./internal-json.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
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

/** Called only after the state-export credential and bounded request parser.
 * Private producers retain original S3 identities without falling back to R2
 * for an object whose static replacement is missing or corrupt. */
export async function handleNativeHistoryExport(
  input: unknown,
  env: unknown,
): Promise<Response> {
  const fail = (status: number, error: string) => reply({ error }, status);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    return fail(400, "invalid native history export request");
  if (
    parsed.data.operation === "heads" &&
    new Set(parsed.data.keys).size !== parsed.data.keys.length
  )
    return fail(400, "duplicate native history keys");
  try {
    const source = historyAssetSource(
      parsed.data.release
        ? {
            ...(env as Record<string, unknown>),
            NATIVE_HISTORY_ASSET_RELEASE: parsed.data.release,
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
    if (parsed.data.operation === "heads") {
      const keys = parsed.data.keys;
      type NativeObject = NonNullable<Awaited<ReturnType<typeof describe>>>;
      const objects: (NativeObject | null)[] = new Array(keys.length);
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
              objects[index] = object ?? null;
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        }),
      );
      if (failed)
        return fail(502, "native history static source is unavailable");
      return reply({ version: 1, objects });
    }
    const object = await source.describe(parsed.data.key);
    if (!object) return fail(404, "native history object is not migrated");
    if (!object.sha256)
      return fail(503, "native history source checksum is unavailable");
    if (parsed.data.operation === "verify") {
      // Verify one immutable original near storage without transferring its
      // payload to the operator. Hash bounded ranges, never the whole file in
      // memory; the source retains its metadata, byte and request limits.
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
      if (
        sha.digest("hex") !== object.sha256 ||
        md5.digest("hex") !== object.etag
      )
        return fail(502, "native history original checksum mismatch");
      return reply({ version: 1, object, verified: true });
    }
    if (parsed.data.operation === "head") return reply({ version: 1, object });
    const { key, etag, offset, length } = parsed.data;
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
