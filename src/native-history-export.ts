import { z } from "zod";
import { NATIVE_HISTORY_ASSET_OBJECT_KEY } from "../schemas-src/artifacts/native-history-assets.ts";
import { historyAssetSource } from "./history-asset-source.ts";

const head = z
  .object({
    kind: z.literal("native-history"),
    operation: z.literal("head"),
    key: z.string().max(1024).regex(NATIVE_HISTORY_ASSET_OBJECT_KEY),
  })
  .strict();
const inputSchema = z.discriminatedUnion("operation", [
  head,
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
  const fail = (status: number, error: string) =>
    Response.json(
      { error },
      {
        status,
        headers: { "cache-control": "no-store" },
      },
    );
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    return fail(400, "invalid native history export request");
  try {
    const source = historyAssetSource(
      env,
      {
        read: async () => {
          throw new Error("Native export cannot read an unmapped source");
        },
      },
      "NATIVE_HISTORY",
    );
    if (!source.describe)
      return fail(503, "native history export is not provisioned");
    const object = await source.describe(parsed.data.key);
    if (!object) return fail(404, "native history object is not migrated");
    if (!object.sha256)
      return fail(503, "native history source checksum is unavailable");
    if (parsed.data.operation === "head")
      return Response.json(
        { version: 1, object },
        {
          headers: { "cache-control": "no-store" },
        },
      );
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
