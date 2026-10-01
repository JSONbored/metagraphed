/** Decode a completed, size-checked request without copying its only chunk.
 * Views retain their byte offset and length. Multiple chunks still need one
 * contiguous buffer so UTF-8 decoding sees code points across boundaries. */
export function mcpRequestBodyBytes(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
