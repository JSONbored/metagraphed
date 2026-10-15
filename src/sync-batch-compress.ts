import {
  QUEUE_MESSAGE_MAX_BYTES,
  SYNC_BATCH_MAX_ROWS,
} from "./sync-batch-queue.ts";

// One block's four families remain atomic. Observed block8790494 was476.6KiB
// raw and40.5KiB gzip; compression admits it under the128KiB transport ceiling.
// Byte and row admission are separate from structural validity. Reuse the
// existing5000-row queue budget to bound statement materialization. Refusal
// preserves producer cursor or accepted-message retry/DLQ ownership; only the
// producer or verified repair may split BETWEEN whole blocks.

/** The only algorithm here. `gzip` rather than `deflate-raw` because both ends
 * are workerd and the header costs 18 bytes against a 40 KiB payload, which
 * buys a self-describing stream for nothing that matters. */
export const SYNC_BATCH_COMPRESSION = "gzip" as const;

// Admission budget, not a claim about measured isolate heap. A compressed
// message may satisfy the wire limit while expanding far beyond it. Process
// one admitted body at a time; a producer must reduce its posted block batch
// when either budget refuses it, never split a block's families here.
export const SYNC_BATCH_MAX_DECODED_BYTES = 4 * 1024 * 1024;

export class SyncBatchSizeError extends RangeError {
  constructor(kind: "compressed" | "expanded" | "rows") {
    super(`sync-batches: ${kind} message exceeds its admission budget`);
    this.name = "SyncBatchSizeError";
  }
}

/** Fail resource admission before classification can ACK a valid older body. */
export function assertSyncBatchAdmission(body: unknown): void {
  const message = body as { lane?: unknown; families?: unknown } | null;
  if (!message || message.lane !== "chain-detail") return;
  const families = message.families;
  if (!families || typeof families !== "object" || Array.isArray(families))
    return;
  let rows = 0;
  for (const [name, values] of Object.entries(families)) {
    if (name !== "blockRows" && Array.isArray(values)) rows += values.length;
  }
  if (rows > SYNC_BATCH_MAX_ROWS) throw new SyncBatchSizeError("rows");
}

/**
 * The first two bytes of a gzip stream (0x1f 0x8b).
 *
 * The consumer distinguishes a compressed message from a JSON one by SHAPE --
 * `ArrayBuffer` versus object -- and this is the second check, not the first.
 * A byte array that is not gzip is a message this consumer cannot read, and
 * saying so by magic number produces a diagnosable error rather than a
 * decompression stream failing somewhere inside.
 */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

async function drain(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > maxBytes - total) {
        void reader.cancel().catch(() => undefined);
        throw new SyncBatchSizeError("expanded");
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** True when a consumed body is compressed bytes rather than a JSON object. */
export function isCompressedSyncBatchBody(
  body: unknown,
): body is ArrayBuffer | Uint8Array {
  return body instanceof ArrayBuffer || body instanceof Uint8Array;
}

/**
 * Compress a message, and refuse it if it STILL does not fit.
 *
 * THE BUDGET MEASURES THE COMPRESSED SIZE, which is the whole point: measuring
 * the JSON would keep refusing messages that fit, and measuring nothing would
 * reintroduce metagraphed-infra#360 -- a lane that stopped rather than degraded,
 * because nothing measured a message before sending it.
 *
 * 11.8x is one block's ratio, not a guarantee. A block whose events happen to
 * be less repetitive compresses worse, and the failure has to stay LOUD: the
 * caller answers 502, the producer retries a chunk that was never accepted, and
 * nothing is silently dropped. Degrading by splitting the families is the one
 * thing this must never do.
 */
export async function compressSyncBatchMessage(
  message: unknown,
  maxBytes: number,
): Promise<Uint8Array> {
  assertSyncBatchAdmission(message);
  const json = JSON.stringify(message);
  const raw = new TextEncoder().encode(json);
  if (raw.length > SYNC_BATCH_MAX_DECODED_BYTES)
    throw new SyncBatchSizeError("expanded");
  // A one-chunk ReadableStream rather than a Blob: `Blob` is present in
  // workerd but its `BlobPart` type is not in this project's lib set, and a
  // stream is the shape CompressionStream wants anyway.
  const packed = await drain(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    }).pipeThrough(new CompressionStream(SYNC_BATCH_COMPRESSION)),
    // gzip overhead remains bounded even for an incompressible admitted body.
    SYNC_BATCH_MAX_DECODED_BYTES + 65_536,
  );
  if (packed.length > maxBytes) {
    const lane = (message as { lane?: unknown })?.lane ?? "unknown";
    throw new Error(
      `sync-batches: ${String(lane)} message is ${packed.length} bytes ` +
        `compressed (${raw.length} raw), over the ${maxBytes}-byte budget. ` +
        `These families must land together, so the PRODUCER must post a ` +
        `smaller batch -- splitting them here is the one degradation this ` +
        `shape exists to prevent.`,
    );
  }
  return packed;
}

/**
 * Decompress and parse a message, or null if the bytes are not one.
 * Admission refusals throw so previously accepted messages retain retry/DLQ ownership.
 *
 * NULL RATHER THAN A THROW, because of what the caller does with each. The
 * consumer acks an unparseable message rather than retrying it -- retrying
 * something that can never parse burns the whole attempt budget and
 * dead-letters anyway -- and that decision is easier to get right when "not a
 * message" is a value instead of an exception to remember to catch.
 */
export async function decompressSyncBatchMessage(
  body: unknown,
): Promise<unknown> {
  if (!isCompressedSyncBatchBody(body)) return null;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  if (bytes.length > QUEUE_MESSAGE_MAX_BYTES)
    throw new SyncBatchSizeError("compressed");
  if (
    bytes.length < 2 ||
    bytes[0] !== GZIP_MAGIC[0] ||
    bytes[1] !== GZIP_MAGIC[1]
  ) {
    return null;
  }
  try {
    const raw = await drain(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }).pipeThrough(new DecompressionStream(SYNC_BATCH_COMPRESSION)),
      SYNC_BATCH_MAX_DECODED_BYTES,
    );
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch (error) {
    // This may be an already accepted message from an older sender. Preserve
    // it for retry/DLQ repair; a resource refusal must never become an ACK.
    if (error instanceof SyncBatchSizeError) throw error;
    // Truncated bytes, a corrupted stream, or valid gzip that is not JSON. All
    // three are "this will not parse on the fifth attempt either".
    return null;
  }
}
