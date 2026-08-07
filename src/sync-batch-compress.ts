// Compressing a sync-batches message, so the largest lane can travel at all
// (metagraphed-infra#359, metagraphed#9759).
//
// WHY, MEASURED. `chain-detail`'s indivisible unit is ONE block: its four row
// families are posted together precisely so a block and its extrinsics cannot
// land separately, and `packMultiFamilyMessage` refuses to split them for that
// reason. So the question was never "how many blocks per message" -- the batch
// is already one block. It is whether one block fits.
//
// As raw JSON it does not. Built from the real rows of the busiest block
// captured (#8790494 -- 35 extrinsics, 694 chain events, 515 account events,
// 1,245 rows):
//
//   raw JSON     476.6 KiB     against a 128 KiB per-message cap -- 3.7x over
//   gzip -9       40.5 KiB     11.8x, 87.5 KiB of headroom, ~3 blocks/message
//
// The payload is enormously repetitive -- the same ss58 addresses, pallet names
// and event kinds hundreds of times over -- which is why the ratio is decisive
// rather than marginal.
//
// AND IT IS THE LANE THE QUEUE MOST WANTS. `chain-detail` is the largest D1
// writer here and the only continuous one: ~1,245 rows every 12 seconds is
// ~9M rows/day, against `account-balances`' ~1.5M. metagraphed-infra#346's
// argument for one queue was global backpressure -- "a lane left out is a lane
// that can still overwhelm the database the others are being polite about" --
// and this is that lane. The bulk lanes are bursty; this one never stops.
//
// ## What this deliberately does NOT do
//
// It does not compress the four lanes already on the queue. They fit, they are
// running clean, and re-encoding a working transport to make it uniform is the
// change this epic's own non-goals warn against. The DECODER accepts a
// compressed body from any lane, so opting one in later is a producer-side
// change with no consumer deploy -- but nothing is opted in today.

/** The only algorithm here. `gzip` rather than `deflate-raw` because both ends
 * are workerd and the header costs 18 bytes against a 40 KiB payload, which
 * buys a self-describing stream for nothing that matters. */
export const SYNC_BATCH_COMPRESSION = "gzip" as const;

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

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
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
  const json = JSON.stringify(message);
  const raw = new TextEncoder().encode(json);
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
    );
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    // Truncated bytes, a corrupted stream, or valid gzip that is not JSON. All
    // three are "this will not parse on the fifth attempt either".
    return null;
  }
}
