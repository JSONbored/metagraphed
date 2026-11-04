/** Buffer input before acquiring the membership row; no client stream holds a lock. */
export async function bufferNativeRequest(
  request: Request,
  signal: AbortSignal,
  maxBytes: number,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reads = 0;
  const reader = request.body?.getReader();
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
        if (++reads > maxBytes + 1)
          throw new RangeError("Native request exceeds chunk limit");
        if (next.value.byteLength === 0) continue;
        size += next.value.byteLength;
        if (size > maxBytes)
          throw new RangeError("Native request exceeds byte limit");
        chunks.push(next.value.slice());
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
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal,
    ...(reader ? { body: bytes } : {}),
  });
}
