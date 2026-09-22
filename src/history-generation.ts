import {
  HistoryFileSchema,
  HistoryGenerationSchema,
  HistoryObjectSchema,
  type HistoryGeneration,
  type HistoryObject,
} from "../schemas-src/artifacts/history-generation.ts";
import { ParquetPageIndexSchema } from "../schemas-src/artifacts/parquet-page-index.ts";
import { findHistoryHash } from "./history-hash-index.ts";
import {
  boundedParquetBuffer,
  readIndexedParquet,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

type Scope = Pick<HistoryGeneration, "generation" | "network" | "table">;
const generationRoot = (scope: Scope) =>
  `metagraph/indexed-history/v1/${scope.network}/${scope.table}/generations/${scope.generation}`;
const fileKey = (scope: Scope, fileId: number) =>
  `${generationRoot(scope)}/files/${String(fileId).padStart(5, "0")}.json`;

async function readJson(
  source: ParquetRangeSource,
  input: HistoryObject,
  budget: ParquetReadBudget,
  maximum: number,
): Promise<unknown> {
  const { key, etag, bytes } = input;
  const object = HistoryObjectSchema.parse({ key, etag, bytes });
  if (object.bytes > maximum)
    throw new Error("History index exceeds its size budget");
  const file = boundedParquetBuffer(source, object, budget);
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      await file.slice(0, object.bytes),
    ),
  );
}

/** Validate completeness before even an absent hash may produce null. */
export function validateHistoryGeneration(
  input: unknown,
  scope: Scope,
): HistoryGeneration {
  const generation = HistoryGenerationSchema.parse(input);
  if (
    generation.generation !== scope.generation ||
    generation.network !== scope.network ||
    generation.table !== scope.table
  )
    throw new Error("History generation scope mismatch");
  let rows = 0;
  for (const [fileId, file] of generation.files.entries()) {
    if (file.key !== fileKey(scope, fileId))
      throw new Error("History file descriptor scope mismatch");
    rows += file.rows;
  }
  let hashRows = 0;
  for (const [ordinal, shard] of generation.shards.entries()) {
    const prefix = ordinal.toString(16).padStart(3, "0");
    if (
      shard.generation !== scope.generation ||
      shard.network !== scope.network ||
      shard.table !== scope.table ||
      shard.prefix !== prefix ||
      shard.key !== `${generationRoot(scope)}/hash/${prefix}.bin` ||
      shard.bytes !== shard.rows * 40
    )
      throw new Error("History generation hash shard mismatch");
    hashRows += shard.rows;
  }
  if (rows !== generation.rows || hashRows !== rows)
    throw new Error("History generation row count mismatch");
  return generation;
}

export async function loadHistoryGeneration(
  source: ParquetRangeSource,
  descriptor: HistoryObject,
  scope: Scope,
  budget: ParquetReadBudget,
): Promise<HistoryGeneration> {
  if (descriptor.key !== `${generationRoot(scope)}/manifest.json`)
    throw new Error("History generation pointer scope mismatch");
  return validateHistoryGeneration(
    await readJson(source, descriptor, budget, 8 * 1024 * 1024),
    scope,
  );
}

/** Translate a physical source row through its verified repacking manifest.
 * The same budget covers manifests, page indexes, and compressed column data. */
export async function readHistoryRow(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  fileId: number,
  row: number,
  budget: ParquetReadBudget,
): Promise<Record<string, unknown>> {
  const generation = validateHistoryGeneration(input, scope);
  if (
    !Number.isSafeInteger(fileId) ||
    fileId < 0 ||
    fileId >= generation.files.length ||
    !Number.isSafeInteger(row) ||
    row < 0 ||
    row >= generation.files[fileId].rows
  )
    throw new Error("History row pointer outside generation");
  const descriptor = generation.files[fileId];
  const file = HistoryFileSchema.parse(
    await readJson(source, descriptor, budget, 2 * 1024 * 1024),
  );
  if (
    file.generation !== scope.generation ||
    file.network !== scope.network ||
    file.table !== scope.table ||
    file.fileId !== fileId ||
    file.rows !== descriptor.rows
  )
    throw new Error("History source file scope mismatch");
  let next = 0;
  const prefix = `metagraph/indexed-history/v1/${scope.network}/${scope.table}/${file.sourceIdentity}/`;
  for (const [ordinal, part] of file.parts.entries()) {
    const expected = `${prefix}${String(ordinal).padStart(5, "0")}-`;
    if (
      part.rowStart !== next ||
      !part.key.startsWith(expected) ||
      !/^[0-9a-f]{64}\.parquet$/.test(part.key.slice(expected.length)) ||
      part.bytes > 128 * 1024 * 1024 ||
      part.index.key !== part.key.replace(/\.parquet$/, ".page-index.json")
    )
      throw new Error("History part identity or contiguity mismatch");
    next += part.rows;
  }
  if (next !== file.rows) throw new Error("History parts are incomplete");
  // The preceding contiguity proof guarantees exactly one containing part.
  const part = file.parts.find(
    (item) => row >= item.rowStart && row < item.rowStart + item.rows,
  )!;
  const index = ParquetPageIndexSchema.parse(
    await readJson(source, part.index, budget, 8 * 1024 * 1024),
  );
  if (
    index.key !== part.key ||
    index.etag !== part.etag ||
    index.bytes !== part.bytes ||
    index.rows !== part.rows ||
    index.groups.some((group) => group.rows > 512)
  )
    throw new Error("History page index does not identify its bounded part");
  const local = row - part.rowStart;
  const rows = await readIndexedParquet(
    source,
    index,
    local,
    local + 1,
    Object.keys(index.groups[0].columns),
    budget,
  );
  return rows[0];
}

/** A valid physical pointer is insufficient: verify the decoded logical key. */
export async function readHistoryHash(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  hash: string,
  budget: ParquetReadBudget,
): Promise<Record<string, unknown> | null> {
  const generation = validateHistoryGeneration(input, scope);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error("Invalid history hash");
  const shard = generation.shards[parseInt(hash.slice(2, 5), 16)];
  const pointer = await findHistoryHash(
    source,
    shard,
    hash,
    { ...scope, fileRows: generation.files.map((file) => file.rows) },
    budget,
  );
  if (!pointer) return null;
  const row = await readHistoryRow(
    source,
    generation,
    scope,
    pointer.fileId,
    pointer.row,
    budget,
  );
  const logical =
    row[scope.table === "extrinsics" ? "extrinsic_hash" : "block_hash"];
  if (
    typeof logical !== "string" ||
    logical.toLowerCase() !== hash.toLowerCase()
  )
    throw new Error(
      "History hash pointer identifies a different logical record",
    );
  return row;
}
