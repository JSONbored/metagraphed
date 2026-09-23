import {
  HistoryFileSchema,
  HistoryBlockGenerationSchema,
  HistoryGenerationSchema,
  HistoryObjectSchema,
  type HistoryGeneration,
  type HistoryBlockGeneration,
  type HistoryObject,
} from "../schemas-src/artifacts/history-generation.ts";
import { ParquetPageIndexSchema } from "../schemas-src/artifacts/parquet-page-index.ts";
import { findHistoryHash } from "./history-hash-index.ts";
import { findHistoryBlockRuns } from "./history-block-index.ts";
import {
  boundedParquetBuffer,
  readIndexedParquet,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

type Scope = Pick<HistoryBlockGeneration, "generation" | "network" | "table">;
type Generation = HistoryGeneration | HistoryBlockGeneration;
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
  validateGenerationFiles(generation, scope);
  let hashRows = 0;
  const packed = generation.shards[0].offset !== undefined;
  for (const [ordinal, shard] of generation.shards.entries()) {
    const prefix = ordinal.toString(16).padStart(3, "0");
    const name = packed ? "packed" : prefix;
    if (
      shard.generation !== scope.generation ||
      shard.network !== scope.network ||
      shard.table !== scope.table ||
      shard.prefix !== prefix ||
      shard.key !== `${generationRoot(scope)}/hash/${name}.bin` ||
      shard.bytes !== shard.rows * 40 ||
      (packed
        ? shard.offset !== hashRows * 40 ||
          shard.etag !== generation.shards[0].etag
        : shard.offset !== undefined)
    )
      throw new Error("History generation hash shard mismatch");
    hashRows += shard.rows;
  }
  if (hashRows !== generation.rows)
    throw new Error("History generation row count mismatch");
  return generation;
}

function validateGenerationFiles(generation: Generation, scope: Scope): void {
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
  if (rows !== generation.rows || !Number.isSafeInteger(rows))
    throw new Error("History generation row count mismatch");
}

export function validateHistoryBlockGeneration(
  input: unknown,
  scope: Scope,
): HistoryBlockGeneration {
  const generation = HistoryBlockGenerationSchema.parse(input);
  validateGenerationFiles(generation, scope);
  if (
    generation.blockIndex.key !== `${generationRoot(scope)}/blocks/index.json`
  )
    throw new Error("History generation block index scope mismatch");
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

export async function loadHistoryBlockGeneration(
  source: ParquetRangeSource,
  descriptor: HistoryObject,
  scope: Scope,
  budget: ParquetReadBudget,
): Promise<HistoryBlockGeneration> {
  if (descriptor.key !== `${generationRoot(scope)}/block-manifest.json`)
    throw new Error("History generation pointer scope mismatch");
  return validateHistoryBlockGeneration(
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
  const rows = await readFileRanges(
    source,
    generation,
    scope,
    fileId,
    [{ start: row, end: row + 1 }],
    budget,
  );
  return rows[0];
}

export interface HistoryPhysicalPointer {
  fileId: number;
  sourceIdentity: string;
  row: number;
}

/** Hydrate a page of verified physical pointers with one manifest per file.
 * Sort/coalesce adjacent rows, then restore the requested feed ordering. */
export async function readHistoryPointers(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  pointers: readonly HistoryPhysicalPointer[],
  budget: ParquetReadBudget,
): Promise<Record<string, unknown>[]> {
  const generation = validateHistoryBlockGeneration(input, scope);
  if (pointers.length > 5001)
    throw new Error("History pointer page exceeds its budget");
  const grouped = new Map<number, { identity: string; rows: Set<number> }>();
  for (const pointer of pointers) {
    const group = grouped.get(pointer.fileId);
    if (
      !/^[0-9a-f]{64}$/.test(pointer.sourceIdentity) ||
      (group && group.identity !== pointer.sourceIdentity)
    )
      throw new Error("History pointer source identity mismatch");
    if (group) group.rows.add(pointer.row);
    else
      grouped.set(pointer.fileId, {
        identity: pointer.sourceIdentity,
        rows: new Set([pointer.row]),
      });
  }
  const hydrated = new Map<string, Record<string, unknown>>();
  for (const [fileId, group] of grouped) {
    const ordinals = [...group.rows].sort((a, b) => a - b);
    const ranges: { start: number; end: number }[] = [];
    for (const row of ordinals) {
      const last = ranges.at(-1);
      if (last && last.end === row) last.end++;
      else ranges.push({ start: row, end: row + 1 });
    }
    const rows = await readFileRanges(
      source,
      generation,
      scope,
      fileId,
      ranges,
      budget,
      group.identity,
    );
    rows.forEach((row, index) =>
      hydrated.set(`${fileId}:${ordinals[index]}`, row),
    );
  }
  return pointers.map((pointer) =>
    hydrated.get(`${pointer.fileId}:${pointer.row}`)!,
  );
}

/** Read every physical run with one file-manifest read and shared page indexes.
 * No partial result escapes if any run fails identity or budget checks. */
async function readFileRanges(
  source: ParquetRangeSource,
  generation: Generation,
  scope: Scope,
  fileId: number,
  ranges: { start: number; end: number }[],
  budget: ParquetReadBudget,
  sourceIdentity?: string,
): Promise<Record<string, unknown>[]> {
  if (
    !Number.isSafeInteger(fileId) ||
    fileId < 0 ||
    fileId >= generation.files.length ||
    ranges.some(
      ({ start, end }) =>
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > generation.files[fileId].rows,
    )
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
    file.rows !== descriptor.rows ||
    (sourceIdentity !== undefined && file.sourceIdentity !== sourceIdentity)
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
  const indexes = new Map<
    string,
    ReturnType<typeof ParquetPageIndexSchema.parse>
  >();
  const rows: Record<string, unknown>[] = [];
  for (const range of ranges)
    for (const part of file.parts) {
      const start = Math.max(range.start, part.rowStart),
        end = Math.min(range.end, part.rowStart + part.rows);
      if (start >= end) continue;
      let index = indexes.get(part.key);
      if (!index) {
        index = ParquetPageIndexSchema.parse(
          await readJson(source, part.index, budget, 8 * 1024 * 1024),
        );
        if (
          index.key !== part.key ||
          index.etag !== part.etag ||
          index.bytes !== part.bytes ||
          index.rows !== part.rows ||
          index.groups.some((group) => group.rows > 512)
        )
          throw new Error(
            "History page index does not identify its bounded part",
          );
        indexes.set(part.key, index);
      }
      rows.push(
        ...(await readIndexedParquet(
          source,
          index,
          start - part.rowStart,
          end - part.rowStart,
          Object.keys(index.groups[0].columns),
          budget,
        )),
      );
    }
  return rows;
}

/** Block indexes retain all captures; route-specific logical deduplication
 * happens after this complete, verified physical read. */
export async function readHistoryBlock(
  source: ParquetRangeSource,
  input: unknown,
  scope: Scope,
  block: number,
  budget: ParquetReadBudget,
): Promise<Record<string, unknown>[]> {
  const generation = validateHistoryBlockGeneration(input, scope);
  const index = await readJson(
    source,
    generation.blockIndex,
    budget,
    8 * 1024 * 1024,
  );
  const runs = await findHistoryBlockRuns(
    source,
    index,
    { ...scope, fileRows: generation.files.map((file) => file.rows) },
    block,
    budget,
  );
  const files = new Map<number, typeof runs>();
  for (const run of runs) {
    const group = files.get(run.fileId) ?? [];
    group.push(run);
    files.set(run.fileId, group);
  }
  const result: Record<string, unknown>[] = [];
  for (const [fileId, group] of files) {
    const rows = await readFileRanges(
      source,
      generation,
      scope,
      fileId,
      group.map((run) => ({
        start: run.rowStart,
        end: run.rowStart + run.rows,
      })),
      budget,
    );
    let offset = 0;
    for (const run of group)
      for (let i = 0; i < run.rows; i++) {
        const row = rows[offset++];
        if (
          String(row.block_number) !== String(block) ||
          String(row.observed_at) !== String(run.observedAt)
        )
          throw new Error(
            "History block pointer identifies a different logical record",
          );
        result.push(row);
      }
  }
  return result;
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
    {
      ...scope,
      table: generation.table,
      fileRows: generation.files.map((file) => file.rows),
    },
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
