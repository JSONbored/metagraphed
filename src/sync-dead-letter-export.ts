import { z } from "zod";
import { historySha256 } from "./history-sha256.ts";
import { internalJson } from "./internal-json.ts";
import {
  SYNC_QUARANTINE_MAX_BYTES,
  SYNC_QUARANTINE_PREFIX,
  readSyncDeadLetterEnvelope,
} from "./sync-dead-letter-store.ts";

const digest = /^[a-f0-9]{64}$/;
const cursor = z.string().min(1).max(2048);
const base = z.object({ kind: z.literal("dead-letter") });
const schema = z.discriminatedUnion("operation", [
  base
    .extend({ operation: z.literal("list"), cursor: cursor.optional() })
    .strict(),
  base
    .extend({
      operation: z.literal("read"),
      sha256: z.string().length(64).regex(digest),
      bytes: z.number().int().min(1).max(SYNC_QUARANTINE_MAX_BYTES).optional(),
    })
    .strict(),
]);

/** Called only behind state-export authentication. No arbitrary control keys,
 * public registry publication, replay, expiry or deletion are exposed. */
export async function handleSyncDeadLetterExport(
  input: unknown,
  env: { METAGRAPH_CONTROL?: Pick<KVNamespace, "get" | "list"> },
): Promise<Response> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return internalJson({ error: "invalid quarantine export request" }, 400);
  const store = env.METAGRAPH_CONTROL;
  if (!store)
    return internalJson({ error: "quarantine export is not provisioned" }, 503);
  const value = parsed.data;
  try {
    if (value.operation === "read") {
      const bytes = await readSyncDeadLetterEnvelope(
        store,
        SYNC_QUARANTINE_PREFIX + value.sha256,
      );
      if (
        bytes === null ||
        bytes.byteLength < 1 ||
        (value.bytes !== undefined && bytes.byteLength !== value.bytes) ||
        historySha256(new Uint8Array(bytes)) !== value.sha256
      )
        throw new Error("Quarantine envelope differs");
      return new Response(new Uint8Array(bytes), {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "x-content-sha256": value.sha256,
        },
      });
    }
    const page = await store.list({
      prefix: SYNC_QUARANTINE_PREFIX,
      limit: 100,
      ...(value.cursor ? { cursor: value.cursor } : {}),
    });
    if (
      !Array.isArray(page.keys) ||
      page.keys.length > 100 ||
      typeof page.list_complete !== "boolean" ||
      (!page.list_complete && !cursor.safeParse(page.cursor).success)
    )
      throw new Error("Quarantine page differs");
    const envelopes = page.keys.map(({ name }) => {
      const sha256 = name.slice(SYNC_QUARANTINE_PREFIX.length);
      if (
        !name.startsWith(SYNC_QUARANTINE_PREFIX) ||
        sha256.length !== 64 ||
        !digest.test(sha256)
      )
        throw new Error("Quarantine key differs");
      return { sha256 };
    });
    // This is KV page traversal, never a queue census or a proof that eventual
    // publication is complete. Each fetched envelope needs its own readback.
    return internalJson({
      version: 1,
      envelopes,
      list_complete: page.list_complete,
      ...(!page.list_complete ? { cursor: page.cursor } : {}),
    });
  } catch {
    return internalJson(
      { error: "quarantine content is unavailable or changed" },
      502,
    );
  }
}
