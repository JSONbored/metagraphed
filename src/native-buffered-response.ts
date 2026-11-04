import { setImmediate as yieldEventLoop } from "node:timers/promises";

/** Consume a finite native response before releasing its connection owner. */
export async function bufferNativeResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Response> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8 * 1024 * 1024
  )
    throw new RangeError("Invalid native response byte budget");
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0,
    reads = 0;
  const cancel = () => {
    void reader?.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    if (reader)
      for (;;) {
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        if (++reads > Math.min(maxBytes + 1, 65536))
          throw new RangeError("Native response exceeds chunk budget");
        size += next.value.byteLength;
        if (size > maxBytes)
          throw new RangeError("Native response exceeds byte budget");
        if (reads % 128 === 0) {
          await yieldEventLoop();
          signal.throwIfAborted();
        }
        if (next.value.byteLength !== 0) chunks.push(next.value.slice());
      }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(
    [101, 204, 205, 304].includes(response.status) ? null : bytes,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}
