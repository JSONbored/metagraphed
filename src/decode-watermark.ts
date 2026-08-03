// How far the lakehouse has actually been DECODED, published by the decoder
// itself rather than pinned in this repo's config.
//
// WHY THIS EXISTS. `ICEBERG_BLOCKS_MAX` is a static wrangler var, and
// src/blocks-cold-tier.ts routed every cold block read against it. The decode
// lane (metagraphed-infra's `decode-r2` container, hourly) appends newly
// decoded blocks to the Iceberg lakehouse continuously, but the serving Worker
// could not see past that constant until a human re-measured it and redeployed.
// So the seam never advanced on its own: measured in production 2026-08-03,
// block 8,759,000 answered with 29 extrinsics and 100 events while block
// 8,762,600 -- 3,284 blocks later, and served at chain head as a header --
// answered 0 and 0. A block explorer whose block list is live and whose block
// DETAIL is empty is the worst shape: it looks healthy until someone clicks.
//
// THE CONSTANT BECOMES A FLOOR, NEVER A CEILING. The published watermark only
// ever RAISES the seam. If the object is missing, unreadable, malformed, or
// reports a height at or below the configured constant, the constant wins. A
// seam that is too LOW costs column coverage for a few thousand blocks (they
// serve from D1 `blocks_head` with null author/spec_version/event_count); a
// seam that is too HIGH routes reads to a lakehouse that does not hold them
// and answers "missing" for blocks that exist. The first is recoverable, the
// second is a lie, so every failure mode here resolves downward.
//
// WHY AN R2 OBJECT AND NOT A D1 ROW. The writer is a Python container that
// already holds R2 S3 credentials for `metagraphed-artifacts` and already
// PUTs its run manifest there at the end of every load; publishing one more
// small object is a second `put_object` on a client it has open. Writing a D1
// row instead would mean provisioning a Cloudflare API token inside that
// container purely for this -- a net-new credential on the private side, for a
// value that is a single scalar nobody needs to query or join. The serving
// Worker already binds the same bucket as `METAGRAPH_ARCHIVE`, so the read
// side costs no new binding either.

import { registerModuleStateReset } from "./module-state-registry.ts";

/**
 * The published watermark object, in the bucket bound as `METAGRAPH_ARCHIVE`
 * (`metagraphed-artifacts`).
 *
 * Under `metagraph/lakehouse/` rather than beside the parquet parts under
 * `metagraph/bulk/parquet/<date>-decode/`: the parts are per-run and immutable,
 * this is a single mutable pointer that outlives every run.
 */
export const DECODE_WATERMARK_KEY = "metagraph/lakehouse/decode-watermark.json";

/**
 * How long a resolved watermark is reused inside one isolate.
 *
 * The decode lane runs HOURLY (`17 * * * *` on the decode-r2 container), so
 * five minutes bounds the visible lag at ~8% of the producer's own cadence --
 * the seam is effectively as fresh as the data it describes. Going tighter buys
 * nothing: no new value can exist between two runs an hour apart, so the extra
 * reads would all return the identical object. Going wider starts to matter,
 * because the whole point of this module is that a block's extrinsics become
 * queryable the moment the decoder commits them.
 *
 * The cost side is why this is a memo at all rather than a per-request read:
 * `resolveBlocksSeam` runs on every cold block read, and an R2 GET per request
 * would put a network round trip in front of a path whose whole job is to
 * decide WHICH backend to ask. At a 5-minute TTL a warm isolate pays at most
 * 12 GETs an hour no matter the request rate.
 */
export const DECODE_WATERMARK_TTL_MS = 5 * 60 * 1000;

/** The four lakehouse tables the decode lane feeds, in the decoder's order. */
export const DECODE_TABLES = [
  "blocks",
  "extrinsics",
  "chain_events",
  "account_events",
] as const;

export interface DecodeWatermark {
  /**
   * The highest block for which ALL FOUR tables hold decoded rows -- the
   * decoder's `min` across each table's recorded `mg_decode_hi`, not the max.
   * A run that appended `blocks` and died before `chain_events` must not
   * advance this, and under `min` it does not.
   */
  decodedThrough: number;
  /** When the decoder last published, epoch ms; null when it published no
   * parseable timestamp. Every completed run rewrites this even when it
   * appended nothing, so a quiet lane is distinguishable from a stopped one. */
  updatedAt: number | null;
  /** Per-table `mg_decode_hi`, for diagnosis only -- routing uses the min. */
  perTable: Record<string, number> | null;
}

/** Epoch ms from the ISO-8601 the decoder writes, or null if unusable. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A non-negative integer height, or null. Strings are accepted because JSON
 * from a Python producer is a wire format, not a type system. */
function parseHeight(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * The watermark carried by one JSON body, or null when it does not carry one.
 *
 * STRICT ON THE ONE FIELD THAT ROUTES. `decoded_through` must parse to a
 * height or the whole object is rejected -- a partially-understood watermark
 * would raise the seam on a guess. Everything else is diagnostic and degrades
 * to null.
 */
export function parseDecodeWatermark(body: unknown): DecodeWatermark | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const decodedThrough = parseHeight(row.decoded_through);
  if (decodedThrough === null) return null;

  let perTable: Record<string, number> | null = null;
  const raw = row.per_table;
  if (raw && typeof raw === "object") {
    const entries: Record<string, number> = {};
    for (const table of DECODE_TABLES) {
      const height = parseHeight((raw as Record<string, unknown>)[table]);
      if (height !== null) entries[table] = height;
    }
    if (Object.keys(entries).length) perTable = entries;
  }

  return {
    decodedThrough,
    updatedAt: parseTimestamp(row.updated_at),
    perTable,
  };
}

interface WatermarkBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

interface WatermarkEnv {
  METAGRAPH_ARCHIVE?: WatermarkBucket;
}

export interface DecodeWatermarkDeps {
  now?: () => number;
  /** Bypass the memo. The watchdog wants the CURRENT published value, not a
   * value up to a TTL old, because staleness is exactly what it measures. */
  fresh?: boolean;
}

/**
 * One uncached read of the published watermark. Null on anything short of a
 * well-formed object: unbound bucket, missing key, unreadable body, malformed
 * JSON, or a body with no usable `decoded_through`.
 */
export async function readDecodeWatermark(
  env: unknown,
): Promise<DecodeWatermark | null> {
  const bucket = (env as WatermarkEnv | null)?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(DECODE_WATERMARK_KEY);
    if (!object) return null;
    return parseDecodeWatermark(JSON.parse(await object.text()));
  } catch {
    // A watermark that cannot be read is not an error anybody can act on
    // mid-request: the caller falls back to the configured floor, and the
    // watchdog reports the absence on its own tick.
    return null;
  }
}

/** Resolved value plus the moment it expires. The PROMISE is memoized, not the
 * value, so concurrent requests on a cold isolate share one R2 GET instead of
 * racing to issue several. */
let memo: { expiresAt: number; value: Promise<DecodeWatermark | null> } | null =
  null;

registerModuleStateReset("src/decode-watermark.ts", () => {
  memo = null;
});

/** Drop the memo so the next resolve re-reads R2. Exported for tests and for
 * any caller that has just observed the underlying object change. */
export function resetDecodeWatermarkCache(): void {
  memo = null;
}

/**
 * The published watermark, memoized for `DECODE_WATERMARK_TTL_MS`.
 *
 * A null result is cached exactly like a hit: a deployment with no watermark
 * object (self-hosters, CI, the window before the decoder first publishes) must
 * not pay an R2 miss on every single cold block read.
 */
export async function resolveDecodeWatermark(
  env: unknown,
  deps: DecodeWatermarkDeps = {},
): Promise<DecodeWatermark | null> {
  if (deps.fresh) return readDecodeWatermark(env);
  const now = (deps.now ?? Date.now)();
  if (memo && memo.expiresAt > now) return memo.value;
  const value = readDecodeWatermark(env);
  memo = { expiresAt: now + DECODE_WATERMARK_TTL_MS, value };
  return value;
}
