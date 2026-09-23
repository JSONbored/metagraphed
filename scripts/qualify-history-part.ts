import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  buildParquetPageIndex,
  parquetFooter,
} from "./build-parquet-page-index.ts";
import {
  parquetReadBudget,
  readIndexedParquet,
} from "../src/indexed-parquet.ts";

const MAX_PART_BYTES = 128 * 1024 * 1024;
const PartSchema = z.strictObject({
  key: z.string().min(1),
  etag: z.string().regex(/^[0-9a-f]{32}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(MAX_PART_BYTES),
  rows: z.number().int().positive().max(65_536),
});

/** Qualify the same physical bytes the publisher uploads, using the serving
 * decoder. This owns no credentials and cannot change a serving selection. */
export async function qualifyHistoryPart(bytes: Uint8Array, input: unknown) {
  const part = PartSchema.parse(input);
  if (
    bytes.byteLength !== part.bytes ||
    createHash("md5").update(bytes).digest("hex") !== part.etag ||
    createHash("sha256").update(bytes).digest("hex") !== part.sha256
  )
    throw new Error("History part identity mismatch");
  const data = Uint8Array.from(bytes).buffer;
  const file = {
    byteLength: data.byteLength,
    slice: (start: number, end = data.byteLength) => data.slice(start, end),
  };
  const index = await buildParquetPageIndex(
    file,
    part.key,
    part.etag,
    await parquetFooter(file),
  );
  if (
    index.rows !== part.rows ||
    index.groups.some((group) => group.rows > 512)
  )
    throw new Error("History part census or row-group limit mismatch");
  const source = {
    async read(key: string, etag: string, offset: number, length: number) {
      if (
        key !== part.key ||
        etag !== part.etag ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        offset + length > data.byteLength
      )
        throw new Error("History proof range outside pinned part");
      return data.slice(offset, offset + length);
    },
  };
  const points = [];
  for (const row of new Set([0, Math.floor(part.rows / 2), part.rows - 1])) {
    const budget = parquetReadBudget();
    const rows = await readIndexedParquet(
      source,
      index,
      row,
      row + 1,
      Object.keys(index.groups[0].columns),
      budget,
    );
    points.push({ row, rows, budget });
  }
  return { version: 1, part, index, points };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2)
    throw new Error(
      "Usage: qualify-history-part <part.parquet> <identity.json>",
    );
  const [partPath, identityPath] = args;
  const part = PartSchema.parse(
    JSON.parse(await readFile(identityPath, "utf8")),
  );
  if ((await stat(partPath)).size !== part.bytes)
    throw new Error("History part file size mismatch");
  const result = await qualifyHistoryPart(await readFile(partPath), part);
  // Preserve every int64 exactly for the independent Arrow comparison.
  return JSON.stringify(result, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (result) => console.log(result),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
