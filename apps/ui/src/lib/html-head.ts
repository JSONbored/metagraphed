import { Parser, defaultTreeAdapter, type DefaultTreeAdapterMap } from "parse5";

// Only the head prefix is held while the parser finds its insertion boundary.
// The body keeps its original chunks, backpressure and cancellation path.
export const MAX_HTML_HEAD_BYTES = 256 * 1024;

export async function appendHtmlHead(response: Response, html: string): Promise<Response> {
  if (!response.body) return response;

  let headFinished = false;
  let insertionOffset: number | null = null;
  const parser: Parser<DefaultTreeAdapterMap> = new Parser({
    sourceCodeLocationInfo: true,
    treeAdapter: {
      ...defaultTreeAdapter,
      onItemPop(node) {
        if (!defaultTreeAdapter.isElementNode(node) || node.tagName !== "head") return;
        const location = node.sourceCodeLocation;
        // An implied head has no source location and no matching source tag.
        insertionOffset = location?.endTag?.startOffset ?? location?.endOffset ?? null;
        headFinished = true;
        parser.tokenizer.pause();
      },
    },
  });

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const leadingBytes: number[] = [];
  let decodedPrefix = "";
  let parsedBytes = 0;
  let ended = false;

  try {
    while (!headFinished && !ended) {
      const { value, done } = await reader.read();
      ended = done;
      if (done) {
        const text = decoder.decode();
        decodedPrefix += text;
        parser.tokenizer.write(text, true);
        break;
      }
      chunks.push(value);
      for (const byte of value.subarray(0, 3 - leadingBytes.length)) leadingBytes.push(byte);
      const prefix = value.subarray(0, MAX_HTML_HEAD_BYTES - parsedBytes);
      parsedBytes += prefix.byteLength;
      const text = decoder.decode(prefix, { stream: true });
      decodedPrefix += text;
      parser.tokenizer.write(text, false);
      if (!headFinished && value.byteLength > prefix.byteLength) {
        throw new Error(`HTML head exceeds ${MAX_HTML_HEAD_BYTES} bytes`);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    throw error;
  }

  // TextDecoder strips an initial UTF-8 BOM. Keep it in the original bytes
  // while translating the parser's UTF-16 source offset to a byte offset.
  const bomBytes =
    leadingBytes[0] === 0xef && leadingBytes[1] === 0xbb && leadingBytes[2] === 0xbf ? 3 : 0;
  let bytesUntilInsertion =
    insertionOffset === null
      ? null
      : bomBytes + encoder.encode(decodedPrefix.slice(0, insertionOffset)).byteLength;
  const insertion = encoder.encode(html);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        if (bytesUntilInsertion !== null && bytesUntilInsertion <= chunk.byteLength) {
          if (bytesUntilInsertion > 0) controller.enqueue(chunk.subarray(0, bytesUntilInsertion));
          controller.enqueue(insertion);
          if (bytesUntilInsertion < chunk.byteLength) {
            controller.enqueue(chunk.subarray(bytesUntilInsertion));
          }
          bytesUntilInsertion = null;
        } else {
          controller.enqueue(chunk);
          if (bytesUntilInsertion !== null) bytesUntilInsertion -= chunk.byteLength;
        }
      }
      if (ended) {
        controller.close();
        reader.releaseLock();
      }
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          reader.releaseLock();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
  const headers = new Headers(response.headers);
  if (insertionOffset !== null) headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
