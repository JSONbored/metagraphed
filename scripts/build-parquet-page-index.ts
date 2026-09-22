// Pure producer primitive: accepts bounded random reads or a sequential R2
// stream adapter. It parses page headers and skips compressed payloads, so
// indexing an existing archive never materializes its rows or invokes SQL.
import { parquetMetadata, type AsyncBuffer } from "hyparquet/src/index.js";
import { deserializeTCompactProtocol } from "hyparquet/src/thrift.js";
import type { ParquetPageIndex } from "../schemas-src/artifacts/parquet-page-index.ts";
import { validateParquetPageIndex } from "../src/indexed-parquet.ts";

export async function parquetFooter(file: AsyncBuffer): Promise<ArrayBuffer> {
  if (file.byteLength < 12) throw new Error("Parquet file too small");
  const tail = await file.slice(file.byteLength - 8, file.byteLength);
  const view = new DataView(tail);
  const length = view.getUint32(0, true);
  if (
    view.getUint32(4, true) !== 0x31524150 ||
    length > 6 * 1024 * 1024 ||
    length + 8 > file.byteLength - 4
  )
    throw new Error("Invalid Parquet footer");
  return file.slice(file.byteLength - length - 8, file.byteLength);
}

export async function buildParquetPageIndex(
  file: AsyncBuffer,
  key: string,
  etag: string,
  footer: ArrayBuffer,
): Promise<ParquetPageIndex> {
  const metadata = parquetMetadata(footer);
  const index: ParquetPageIndex = {
    version: 1,
    key,
    etag,
    bytes: file.byteLength,
    rows: Number(metadata.num_rows),
    footer: Buffer.from(footer).toString("base64"),
    groups: metadata.row_groups.map((group) => ({
      rows: Number(group.num_rows),
      columns: {},
    })),
  };
  const chunks = metadata.row_groups.flatMap((group, ordinal) =>
    group.columns.map((chunk) => ({ chunk, ordinal })),
  );
  chunks.sort(
    (a, b) =>
      Number(
        a.chunk.meta_data!.dictionary_page_offset ??
          a.chunk.meta_data!.data_page_offset,
      ) -
      Number(
        b.chunk.meta_data!.dictionary_page_offset ??
          b.chunk.meta_data!.data_page_offset,
      ),
  );
  for (const { chunk, ordinal } of chunks) {
    const meta = chunk.meta_data!;
    if (meta.path_in_schema.length !== 1)
      throw new Error("Nested Parquet is unsupported");
    let position = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
    const end = position + Number(meta.total_compressed_size);
    const pages: ParquetPageIndex["groups"][number]["columns"][string] = [];
    let row = 0;
    while (position < end) {
      const header = await file.slice(
        position,
        Math.min(position + 65536, end),
      );
      const reader = { view: new DataView(header), offset: 0 };
      const fields = deserializeTCompactProtocol(reader);
      const bytes = reader.offset + fields.field_3;
      if (
        !Number.isSafeInteger(bytes) ||
        bytes <= reader.offset ||
        position + bytes > end
      )
        throw new Error("Invalid Parquet page size");
      if (fields.field_1 === 0 || fields.field_1 === 3) {
        const rows: unknown =
          fields.field_1 === 0
            ? fields.field_5?.field_1
            : fields.field_8?.field_3;
        if (
          typeof rows !== "number" ||
          !Number.isSafeInteger(rows) ||
          rows <= 0
        )
          throw new Error("Invalid Parquet page rows");
        pages.push({ offset: position, bytes, row, rows });
        row += rows;
      } else if (
        fields.field_1 !== 2 ||
        position !== Number(meta.dictionary_page_offset)
      ) {
        throw new Error("Unsupported Parquet page type");
      }
      position += bytes;
    }
    index.groups[ordinal].columns[meta.path_in_schema[0]] = pages;
  }
  return validateParquetPageIndex(index).index;
}

/** Forward-only slice view that discards skipped payloads. Retains only the
 * current stream chunk and requested header, including overlapping headers
 * in tiny columns. Call close() in finally, including on producer failure. */
export function sequentialParquetBuffer(
  stream: ReadableStream<Uint8Array>,
  byteLength: number,
): AsyncBuffer & { close(): Promise<void> } {
  const reader = stream.getReader();
  let buffer = new Uint8Array();
  let offset = 0;
  let position = 0;
  return {
    byteLength,
    async slice(start, end = byteLength) {
      if (
        start < offset ||
        end < start ||
        end > byteLength ||
        end - start > 65536
      )
        throw new Error("Invalid sequential Parquet range");
      if (start > offset) {
        buffer = buffer.subarray(Math.min(start - offset, buffer.length));
        offset = Math.min(start, position);
      }
      while (position < end) {
        const next = await reader.read();
        if (next.done) throw new Error("Truncated Parquet stream");
        const chunkStart = position;
        position += next.value.byteLength;
        if (position <= start) {
          offset = position;
          continue;
        }
        const incoming = next.value.subarray(Math.max(0, start - chunkStart));
        const combined = new Uint8Array(buffer.length + incoming.length);
        combined.set(buffer);
        combined.set(incoming, buffer.length);
        buffer = combined;
        offset = start;
      }
      return buffer.slice(0, end - start).buffer;
    },
    async close() {
      await reader.cancel();
      reader.releaseLock();
    },
  };
}
