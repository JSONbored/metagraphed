/** Select a bounded PNG-backed ICO frame; Sharp still validates its pixels. */
export function icoPngFrame(source: Uint8Array): Uint8Array {
  const invalid = () => new Error("Invalid or unsupported sharing ICO");
  if (
    !(source instanceof Uint8Array) ||
    source.byteLength < 6 ||
    source.byteLength > 512 * 1024
  ) {
    throw invalid();
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const count = view.getUint16(4, true);
  const directoryEnd = 6 + count * 16;
  if (
    view.getUint16(0, true) !== 0 ||
    view.getUint16(2, true) !== 1 ||
    count < 1 ||
    count > 256 ||
    directoryEnd > source.byteLength
  ) {
    throw invalid();
  }
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  let selected: { offset: number; bytes: number; area: number } | undefined;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const width = source[entry] || 256;
    const height = source[entry + 1] || 256;
    const bytes = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (
      source[entry + 3] !== 0 ||
      bytes < 1 ||
      offset < directoryEnd ||
      offset + bytes > source.byteLength
    ) {
      throw invalid();
    }
    if (!pngSignature.every((value, part) => source[offset + part] === value)) {
      // Recognize bounded DIB alternatives to skip them, never decode them.
      if (bytes < 40) throw invalid();
      const headerBytes = view.getUint32(offset, true);
      if (
        ![40, 108, 124].includes(headerBytes) ||
        headerBytes > bytes ||
        view.getInt32(offset + 4, true) !== width ||
        Math.abs(view.getInt32(offset + 8, true)) !== height * 2 ||
        view.getUint16(offset + 12, true) !== 1 ||
        ![1, 4, 8, 16, 24, 32].includes(view.getUint16(offset + 14, true))
      ) {
        throw invalid();
      }
      continue;
    }
    if (
      bytes < 33 ||
      view.getUint32(offset + 8) !== 13 ||
      view.getUint32(offset + 12) !== 0x49484452 ||
      view.getUint32(offset + 16) !== width ||
      view.getUint32(offset + 20) !== height
    ) {
      throw invalid();
    }
    const area = width * height;
    if (!selected || area > selected.area) selected = { offset, bytes, area };
  }
  if (!selected) throw invalid();
  return new Uint8Array(
    source.subarray(selected.offset, selected.offset + selected.bytes),
  );
}
