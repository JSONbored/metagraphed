import { CHAIN_DETAIL_SYNC_MAX_BODY_BYTES } from "./chain-detail-sync-payload.ts";

const DECODE_SLICE_BYTES = 64 * 1024;

/** Match Request.text() followed by utf8Bytes(text), rather than imposing a
 * different raw-wire or Content-Length limit. Streaming UTF-8 decoding keeps
 * BOM removal, replacement characters and split code points consistent with
 * the existing admission rule. Null is the unchanged 413 decision. */
export async function readChainDetailSyncBody(
  request: Request,
): Promise<string | null> {
  if (request.bodyUsed)
    throw new TypeError("Request body has already been used");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let bytes = 0;
  let text = "";

  function append(decoded: string): boolean {
    const length = encoder.encode(decoded).byteLength;
    if (length > CHAIN_DETAIL_SYNC_MAX_BODY_BYTES - bytes) return false;
    bytes += length;
    text += decoded;
    return true;
  }

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      // An upstream read can return one very large chunk. Bound our decoding
      // and re-encoding temporaries even in that case; the upstream allocation
      // itself is outside this reader's control.
      for (
        let offset = 0;
        offset < next.value.byteLength;
        offset += DECODE_SLICE_BYTES
      ) {
        const chunk = next.value.subarray(offset, offset + DECODE_SLICE_BYTES);
        if (!append(decoder.decode(chunk, { stream: true }))) return null;
      }
    }
    if (!append(decoder.decode())) return null;
    return text;
  } finally {
    // Refusal must not await a rejecting or non-settling cancellation. Real
    // read errors still propagate; cancellation cannot replace their reason.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
