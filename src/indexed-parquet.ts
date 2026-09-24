// Ordinary R2 range reads of an immutable Parquet object. There is no SQL
// engine or scan fallback in this path: an invalid index is an error, never
// an empty result. Producers publish a complete generation before selecting it.
import {
  parquetMetadata,
  parquetReadObjects,
  type AsyncBuffer,
  type FileMetaData,
} from "hyparquet/src/index.js";
import { decompress } from "fzstd";
import { deserializeTCompactProtocol } from "hyparquet/src/thrift.js";
import {
  ParquetPageIndexSchema,
  type ParquetPageIndex,
} from "../schemas-src/artifacts/parquet-page-index.ts";

export interface ParquetRangeSource {
  /** Returns exactly the requested bytes, or rejects. The storage adapter
   * must enforce the supplied ETag, including conditional-read failures. */
  read(
    key: string,
    etag: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer>;
}

export interface ParquetReadBudget {
  maxBytes: number;
  maxRequests: number;
  bytes: number;
  requests: number;
  decodedBytes: number;
  values: number;
}

/** One shared budget per user operation, including every candidate file. */
export function parquetReadBudget(
  maxBytes = 24 * 1024 * 1024,
  maxRequests = 64,
): ParquetReadBudget {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1
  ) {
    throw new Error("Invalid Parquet read budget");
  }
  return {
    maxBytes,
    maxRequests,
    bytes: 0,
    requests: 0,
    decodedBytes: 0,
    values: 0,
  };
}

/** Conditional GET does not necessarily return a body when its ETag fails.
 * Check both identity and range instead of accepting a truncated/replaced row. */
export function r2ParquetSource(
  bucket: Pick<R2Bucket, "get">,
): ParquetRangeSource {
  return {
    async read(key, etag, offset, length) {
      const object = await bucket.get(key, {
        onlyIf: { etagMatches: etag },
        range: { offset, length },
      });
      if (
        !object ||
        !("body" in object) ||
        object.etag !== etag ||
        !object.range ||
        !("offset" in object.range) ||
        object.range.offset !== offset ||
        object.range.length !== length
      ) {
        throw new Error("Parquet source missing or changed");
      }
      const bytes = await new Response(object.body).arrayBuffer();
      if (bytes.byteLength !== length)
        throw new Error("Truncated Parquet source range");
      return bytes;
    },
  };
}

/** Validate the complete index before any body read. A missing column index
 * would otherwise make the decoder read its entire column chunk. */
export function validateParquetPageIndex(input: unknown): {
  index: ParquetPageIndex;
  metadata: FileMetaData;
} {
  const index = ParquetPageIndexSchema.parse(input);
  const footer = Uint8Array.from(atob(index.footer), (c) => c.charCodeAt(0));
  const metadata = parquetMetadata(footer.buffer);
  const footerStart = index.bytes - footer.byteLength;
  if (
    footerStart < 4 ||
    Number(metadata.num_rows) !== index.rows ||
    metadata.row_groups.length !== index.groups.length ||
    metadata.schema
      .slice(1)
      .some(
        (s) => s.num_children !== undefined || s.repetition_type === "REPEATED",
      )
  ) {
    throw new Error(
      "Parquet index metadata mismatch or unsupported nested schema",
    );
  }
  let total = 0;
  metadata.row_groups.forEach((group, ordinal) => {
    const indexed = index.groups[ordinal];
    const count = Number(group.num_rows);
    total += count;
    if (
      count !== indexed.rows ||
      group.columns.length !== Object.keys(indexed.columns).length
    ) {
      throw new Error("Parquet index row group mismatch");
    }
    for (const chunk of group.columns) {
      const meta = chunk.meta_data;
      if (!meta || meta.path_in_schema.length !== 1 || chunk.file_path)
        throw new Error("Unsupported Parquet column");
      const start = Number(
        meta.dictionary_page_offset ?? meta.data_page_offset,
      );
      const dataStart = Number(meta.data_page_offset);
      const end = start + Number(meta.total_compressed_size);
      const pages = indexed.columns[meta.path_in_schema[0]];
      if (start < 4 || end > footerStart || !pages || !pages.length)
        throw new Error("Missing Parquet column index");
      let row = 0;
      let previousEnd = dataStart;
      for (const page of pages) {
        if (
          page.row !== row ||
          page.offset !== previousEnd ||
          page.offset + page.bytes > end
        )
          throw new Error("Invalid Parquet page boundaries");
        row += page.rows;
        previousEnd = page.offset + page.bytes;
      }
      if (row !== count || previousEnd !== end)
        throw new Error("Incomplete Parquet column index");
    }
  });
  if (total !== index.rows) throw new Error("Parquet index row count mismatch");
  return { index, metadata };
}

/** Row positions are physical positions from the same generation's lookup
 * index. Big integers remain big integers for the table-specific boundary to
 * normalize; this layer never rounds chain values into JavaScript numbers. */
export async function readIndexedParquet(
  source: ParquetRangeSource,
  input: unknown,
  rowStart: number,
  rowEnd: number,
  columns: string[],
  budget: ParquetReadBudget,
): Promise<Record<string, unknown>[]> {
  const { index, metadata } = validateParquetPageIndex(input);
  if (
    !Number.isSafeInteger(rowStart) ||
    !Number.isSafeInteger(rowEnd) ||
    rowStart < 0 ||
    rowEnd <= rowStart ||
    rowEnd > index.rows ||
    columns.length === 0 ||
    new Set(columns).size !== columns.length ||
    columns.some((c) => !Object.hasOwn(index.groups[0].columns, c))
  ) {
    throw new Error("Invalid indexed Parquet selection");
  }
  const bounded = boundedParquetBuffer(source, index, budget);
  // Repacked history uses small row groups. Fetch their selected columns in
  // one range, while retaining page pruning for legacy, large row groups.
  let groupStart = 0;
  const groupRanges = metadata.row_groups.flatMap((group) => {
    const startRow = groupStart;
    groupStart += Number(group.num_rows);
    if (
      groupStart <= rowStart ||
      startRow >= rowEnd ||
      Number(group.num_rows) > 512
    )
      return [];
    const chunks = group.columns.filter((c) =>
      columns.includes(c.meta_data!.path_in_schema[0]),
    );
    if (
      chunks.some(
        (chunk) => Number(chunk.meta_data!.total_compressed_size) > 1024 * 1024,
      )
    )
      return [];
    const ranges: {
      start: number;
      end: number;
      bytes: Promise<ArrayBuffer> | undefined;
    }[] = [];
    for (const chunk of chunks) {
      const start = Number(
        chunk.meta_data!.dictionary_page_offset ??
          chunk.meta_data!.data_page_offset,
      );
      const end = start + Number(chunk.meta_data!.total_compressed_size);
      const prior = ranges.at(-1);
      if (prior && start === prior.end && end - prior.start <= 1024 * 1024)
        prior.end = end;
      else ranges.push({ start, end, bytes: undefined });
    }
    return ranges;
  });
  // Adjacent groups often separate tiny filter columns by a small omitted
  // column. Share one bounded read without pulling a wide payload into it.
  // Extra bytes never exceed the selected bytes in a merged span.
  const compactRanges: ((typeof groupRanges)[number] & {
    selectedBytes: number;
  })[] = [];
  for (const range of groupRanges.sort((a, b) => a.start - b.start)) {
    const prior = compactRanges.at(-1);
    const selectedBytes = range.end - range.start;
    if (
      prior &&
      range.start >= prior.end &&
      range.start - prior.end <= 1024 &&
      range.end - prior.start <= 64 * 1024 &&
      range.end - prior.start <= 2 * (prior.selectedBytes + selectedBytes)
    ) {
      prior.end = range.end;
      prior.selectedBytes += selectedBytes;
    } else {
      compactRanges.push({ ...range, selectedBytes });
    }
  }
  const file: AsyncBuffer = {
    byteLength: bounded.byteLength,
    async slice(start, end) {
      const range = compactRanges.find(
        (r) => start >= r.start && end !== undefined && end <= r.end,
      );
      let bytes: ArrayBuffer;
      if (range) {
        range.bytes ??= Promise.resolve(bounded.slice(range.start, range.end));
        bytes = (await range.bytes).slice(
          start - range.start,
          end! - range.start,
        );
      } else {
        bytes = await bounded.slice(start, end);
      }
      reserveParquetPageMemory(bytes, budget);
      return bytes;
    },
  };
  // The planner's external-page-index option is pinned to hyparquet 1.31.1.
  // Real multi-page fixtures guard dependency upgrades against a full scan.
  const options = {
    file,
    metadata,
    rowStart,
    rowEnd,
    columns,
    compressors: {
      ZSTD: (bytes: Uint8Array, length: number) =>
        decompress(bytes, new Uint8Array(length)),
    },
    pageLocationsByGroup: index.groups.map((group) =>
      Object.fromEntries(
        Object.entries(group.columns).map(([name, pages]) => [
          name,
          pages.map((page) => ({
            offset: BigInt(page.offset),
            compressed_page_size: page.bytes,
            first_row_index: BigInt(page.row),
          })),
        ]),
      ),
    ),
  };
  const rows = await parquetReadObjects(options);
  if (rows.length !== rowEnd - rowStart)
    throw new Error("Incomplete indexed Parquet result");
  return rows;
}

/** Check actual headers before decompression, including dictionaries. A small
 * compressed page can otherwise allocate an unbounded value array. These
 * limits are shared across all files read by the caller's operation. */
export function reserveParquetPageMemory(
  bytes: ArrayBuffer,
  budget: ParquetReadBudget,
): void {
  const reader = { view: new DataView(bytes), offset: 0 };
  while (reader.offset < bytes.byteLength) {
    const page = deserializeTCompactProtocol(reader);
    const compressed: unknown = page.field_3;
    const decoded: unknown = page.field_2;
    const values: unknown =
      page.field_1 === 0
        ? page.field_5?.field_1
        : page.field_1 === 3
          ? page.field_8?.field_1
          : page.field_1 === 2
            ? page.field_7?.field_1
            : undefined;
    if (
      typeof compressed !== "number" ||
      !Number.isSafeInteger(compressed) ||
      compressed < 0 ||
      reader.offset + compressed > bytes.byteLength ||
      typeof decoded !== "number" ||
      !Number.isSafeInteger(decoded) ||
      decoded < 0 ||
      typeof values !== "number" ||
      !Number.isSafeInteger(values) ||
      values < 0
    )
      throw new Error("Invalid Parquet page header");
    if (
      budget.decodedBytes + decoded > 32 * 1024 * 1024 ||
      budget.values + values > 1_000_000
    )
      throw new Error("Indexed Parquet decoded memory budget exceeded");
    budget.decodedBytes += decoded;
    budget.values += values;
    reader.offset += compressed;
  }
}

export function boundedParquetBuffer(
  source: ParquetRangeSource,
  index: Pick<ParquetPageIndex, "key" | "etag" | "bytes">,
  budget: ParquetReadBudget,
): AsyncBuffer {
  return {
    byteLength: index.bytes,
    async slice(start, end = index.bytes) {
      const length = end - start;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end > index.bytes ||
        length < 1
      )
        throw new Error("Invalid Parquet byte range");
      // Reserve synchronously, before awaiting concurrent decoder requests.
      if (
        budget.bytes + length > budget.maxBytes ||
        budget.requests + 1 > budget.maxRequests
      )
        throw new Error("Indexed Parquet read budget exceeded");
      budget.bytes += length;
      budget.requests++;
      const bytes = await source.read(index.key, index.etag, start, length);
      if (bytes.byteLength !== length)
        throw new Error("Truncated Parquet source range");
      return bytes;
    },
  };
}
