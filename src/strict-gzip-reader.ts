import type { TransformOptions } from "node:stream";
import { crc32, createInflateRaw, type ZlibOptions } from "node:zlib";

/**
 * STATIC DESIGN CANDIDATE ONLY. Not integrated or qualified.
 *
 * The pinned workerd node:zlib shim caps native output with avail_out and
 * pauses its native continuation when push() reaches readable highWaterMark.
 * Unlike DecompressionStream, it does not inflate an entire input slice into
 * an unbounded native output vector.
 */
const INPUT_BYTES = 4096;
const OUTPUT_BYTES = 8192;

function invalid(): never {
  throw new TypeError("Invalid gzip stream");
}

// Private reads from the caller's immutable snapshot. headerEnd admits length
// >= 18 and keeps its cursor between 10 and length - 8 before either u16 call.
function u16(input: Uint8Array, at: number): number {
  return input[at]! | (input[at + 1]! << 8);
}

// The only callers follow the exact trailer + 8 === length check, at offsets
// length - 8 and length - 4. Keep that framing check before both reads.
function u32(input: Uint8Array, at: number): number {
  return (
    (input[at]! |
      (input[at + 1]! << 8) |
      (input[at + 2]! << 16) |
      (input[at + 3]! << 24)) >>>
    0
  );
}

/** Header metadata is skipped in the immutable compressed snapshot. No
 * potentially unbounded FNAME/FCOMMENT string or FEXTRA copy is created. */
function headerEnd(input: Uint8Array): number {
  if (
    input.length < 18 ||
    input[0] !== 0x1f ||
    input[1] !== 0x8b ||
    input[2] !== 8 ||
    (input[3]! & 0xe0) !== 0
  )
    return invalid();
  const flags = input[3]!;
  let at = 10;
  if (flags & 4) {
    const length = u16(input, at);
    at += 2 + length;
    if (at > input.length - 8) return invalid();
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      while (at < input.length - 8 && input[at] !== 0) at++;
      if (at >= input.length - 8) return invalid();
      at++;
    }
  }
  if (flags & 2) {
    if (u16(input, at) !== (crc32(input.subarray(0, at)) & 0xffff))
      return invalid();
    at += 2;
  }
  if (at > input.length - 8) return invalid();
  return at;
}

/**
 * Demand-driven native raw inflate plus strict single-member gzip framing.
 * At most one write is pending. This iterator has no background input loop:
 * returning an output chunk suspends all further compressed writes until the
 * caller demands the next chunk. A current native write can settle while the
 * caller is stalled, but its output is bounded by the native shim's credit.
 * OUTPUT_BYTES is a delivery size, not a total memory bound: readable-queue
 * overshoot, the current result and the native output allocation can coexist.
 * A compressed-input ceiling remains a caller/protocol precondition.
 *
 * read()/readableLength are synchronous queue-state APIs. No timeout or
 * microtask ordering is used to guess whether output is buffered.
 */
export interface StrictGzipReader extends AsyncIterableIterator<Uint8Array> {
  next(): Promise<IteratorResult<Uint8Array, void>>;
  return(): Promise<IteratorResult<Uint8Array, void>>;
  cancel(): void;
}

export function readStrictGzip(owned: Uint8Array): StrictGzipReader {
  const start = headerEnd(owned);
  const options: ZlibOptions & TransformOptions = {
    chunkSize: OUTPUT_BYTES,
    readableHighWaterMark: OUTPUT_BYTES,
    writableHighWaterMark: INPUT_BYTES,
  };
  const inflater = createInflateRaw(options);
  let at = start;
  let writing = false;
  let closing = false;
  let ended = false;
  let failure: Error | undefined;
  let revision = 0;
  let wake: (() => void) | undefined;
  let checksum = 0;
  let size = 0;
  let stopped = false;
  let reading = false;
  const notify = () => {
    revision++;
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  inflater.on("readable", notify);
  inflater.on("error", (error: Error) => {
    failure = error;
    notify();
  });
  inflater.on("end", () => {
    ended = true;
    notify();
  });
  inflater.on("close", () => {
    if (!ended && !failure) failure = new TypeError("Gzip stream closed early");
    notify();
  });
  const written = (error?: Error | null) => {
    writing = false;
    if (error) failure = error;
    notify();
  };
  const cancel = () => {
    // Cancellation must interrupt a pending next(), not wait behind it as an
    // async generator's return() would. Incidental close/error events lose to
    // the explicit stopped state. Keep the error listener for deferred errors.
    stopped = true;
    notify();
    inflater.destroy();
  };
  const reader: StrictGzipReader = {
    [Symbol.asyncIterator]() {
      return reader;
    },
    cancel,
    return() {
      cancel();
      return Promise.resolve({ done: true, value: undefined });
    },
    async next() {
      if (stopped) return { done: true, value: undefined };
      if (reading) throw new TypeError("Concurrent gzip read");
      reading = true;
      try {
        for (;;) {
          if (stopped) return { done: true, value: undefined };
          if (failure) throw failure;
          const observedRevision = revision;
          // read(0) starts a pending native continuation if the readable side
          // needs it; positive reads return at most our output delivery size.
          const chunk: Uint8Array | null = inflater.read(
            Math.min(inflater.readableLength, OUTPUT_BYTES),
          );
          if (chunk !== null) {
            checksum = crc32(chunk, checksum);
            size = (size + chunk.byteLength) >>> 0;
            return { done: false, value: chunk };
          }
          if (stopped) return { done: true, value: undefined };
          if (failure) throw failure;
          if (ended) {
            // Raw inflate stops at the first final deflate block. bytesWritten
            // counts consumed input, not submitted input. Only an exact
            // eight-byte gzip trailer may remain, even across write boundaries.
            const trailer = start + inflater.bytesWritten;
            if (
              trailer + 8 !== owned.length ||
              u32(owned, trailer) !== checksum ||
              u32(owned, trailer + 4) !== size
            )
              invalid();
            cancel();
            return { done: true, value: undefined };
          }
          // A synchronous native continuation started by read(0) may have just
          // filled the readable queue. Drain it before admitting more input.
          if (inflater.readableLength > 0) continue;
          if (!writing && !closing) {
            writing = true;
            if (at < owned.length) {
              const end = Math.min(at + INPUT_BYTES, owned.length);
              const input = owned.subarray(at, end);
              at = end;
              inflater.write(input, written);
            } else {
              closing = true;
              inflater.end(written);
            }
          }
          if (revision !== observedRevision) continue;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } catch (error) {
        cancel();
        throw error;
      } finally {
        reading = false;
      }
    },
  };
  return reader;
}
